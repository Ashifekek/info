export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const host = req.headers.host || 'localhost';
    const urlObj = new URL(req.url, `https://${host}`);
    const pathSlug = urlObj.pathname.replace(/^\/+|\/+$/g, '');

    const { key, api: queryApi, pretty, ...extraParams } = req.query;
    const targetApi = (pathSlug && pathSlug !== 'api') ? pathSlug : queryApi;

    // ERROR 1: Missing Parameters
    if (!key || !targetApi) {
        return res.status(400).json({
            error: "Authentication Failed",
            message: "You must provide a valid 'key' and an API slug."
        });
    }

    const FIREBASE_URL = "https://realtime-database-tdn-default-rtdb.firebaseio.com/db.json";

    let dbStr;
    try {
        const dbReq = await fetch(FIREBASE_URL);
        dbStr = await dbReq.text();
    } catch (e) {
        return res.status(500).json({ error: "System Error", message: "Unable to connect to master database." });
    }

    const db = (dbStr && dbStr !== 'null') ? JSON.parse(dbStr) : { apis: {}, keys: {}, settings: {} };

    // DB SETTINGS CHECK
    if (db.settings?.global_maintenance) {
        return res.status(503).json({ error: "System is currently undergoing global maintenance. Please try again later." });
    }

    // KEY & API CHECK
    let keyData = db.keys ? db.keys[key] : null;
    if (key === 'MASTER_TEST_KEY') {
        keyData = { 
            status: "active", ip_whitelist: "", allowed_apis: [targetApi], expires_at: Date.now()/1000 + 86400, 
            limits: {hourly: 0, daily: 0, weekly: 0, monthly: 0},
            usage: {hourly_count: 0, daily_count: 0, weekly_count: 0, monthly_count: 0}
        };
    } else if (!keyData) {
        return res.status(403).json({ error: "Invalid API Key." });
    }

    const apiConfig = db.apis ? db.apis[targetApi] : null;
    if (!apiConfig) {
        return res.status(404).json({ error: "This API module has been deleted or permanently removed by the developer." });
    }

    if (apiConfig.status === 'offline') {
        return res.status(503).json({ error: apiConfig.offline_msg || "This specific API module is currently offline for maintenance." });
    }
    if (keyData.status === 'suspended') {
        return res.status(403).json({ error: "This API key has been suspended by the administrator." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    if (keyData.ip_whitelist) {
        const allowedIps = keyData.ip_whitelist.split(',').map(s => s.trim());
        if (!allowedIps.includes(clientIp)) {
            return res.status(403).json({ error: `Access Denied: Your IP (${clientIp}) is not whitelisted for this key.` });
        }
    }

    if (key !== 'MASTER_TEST_KEY' && (!keyData.allowed_apis || !keyData.allowed_apis.includes(targetApi))) {
        return res.status(403).json({ error: "Access denied to this API module." });
    }
    if (Date.now() / 1000 > keyData.expires_at) {
        return res.status(403).json({ error: "Subscription Expired." });
    }

    // LIMIT CHECKS
    const dHour = new Date().toISOString().slice(0, 13);
    const dDay = new Date().toISOString().slice(0, 10);
    const dMonth = new Date().toISOString().slice(0, 7);

    if (keyData.usage.hour_timestamp !== dHour) { keyData.usage.hourly_count = 0; keyData.usage.hour_timestamp = dHour; }
    if (keyData.usage.day_timestamp !== dDay) { keyData.usage.daily_count = 0; keyData.usage.day_timestamp = dDay; }
    if (keyData.usage.month_timestamp !== dMonth) { keyData.usage.monthly_count = 0; keyData.usage.month_timestamp = dMonth; }

    if (keyData.limits.hourly > 0 && keyData.usage.hourly_count >= keyData.limits.hourly) return res.status(429).json({ error: "Hourly rate limit exceeded." });
    if (keyData.limits.daily > 0 && keyData.usage.daily_count >= keyData.limits.daily) return res.status(429).json({ error: "Daily rate limit exceeded." });
    if (keyData.limits.monthly > 0 && keyData.usage.monthly_count >= keyData.limits.monthly) return res.status(429).json({ error: "Monthly rate limit exceeded." });

    // INCREMENT USAGE
    if (key !== 'MASTER_TEST_KEY') {
        keyData.usage.hourly_count++;
        keyData.usage.daily_count++;
        keyData.usage.monthly_count++;
        
        db.keys[key] = keyData;
        
        // BACKGROUND SAVE (Non-blocking)
        fetch(FIREBASE_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(db)
        }).catch(()=>{});
    }

    // BRANDING
    const brandMode = apiConfig.branding_mode || 'global';
    const branding = brandMode === 'global' ? {
        channel: db.settings?.channel || "@LofzAI_Telegram",
        developer: db.settings?.developer || "@LofzDev"
    } : {};

    // BUILD URL
    let targetUrl = apiConfig.target_url;
    const qp = apiConfig.query_param || 'query';
    let mainQueryVal = extraParams[qp] || null;

    let replacedKeys = new Set();
    targetUrl = targetUrl.replace(/\[([^\]]+)\]/gi, (match, paramName) => {
        let pName = paramName.toLowerCase();
        if (pName === 'query' || pName === qp.toLowerCase()) {
            if (mainQueryVal !== null) {
                replacedKeys.add(qp);
                return encodeURIComponent(mainQueryVal);
            }
        } else {
            let foundKey = Object.keys(extraParams).find(k => k.toLowerCase() === pName);
            if (foundKey) {
                replacedKeys.add(foundKey);
                return encodeURIComponent(extraParams[foundKey]);
            }
        }
        return match;
    });

    const builtUrl = new URL(targetUrl);
    if (apiConfig.forward_all) {
        Object.entries(extraParams).forEach(([k, v]) => {
            if (!replacedKeys.has(k)) {
                builtUrl.searchParams.append(k, v);
            }
        });
    } else if (mainQueryVal !== null && !replacedKeys.has(qp)) {
        builtUrl.searchParams.append(qp, mainQueryVal);
    }

    try {
        const response = await fetch(builtUrl.href, { method: "GET" });
        if (!response.ok) {
            return res.status(response.status).json({ error: "Provider Error", message: "Upstream provider returned an error." });
        }
        const textResponse = await response.text();
        
        let jsonData;
        try {
            jsonData = JSON.parse(textResponse);
        } catch(e) {
            return res.status(502).json({ error: "Invalid Provider Response", message: "Upstream provider returned non-JSON data." });
        }

        // REMOVE KEYS
        const removeKeysList = apiConfig.remove_keys || [];
        const deleteNestedKeys = (obj, keysToRemove) => {
            for (let prop in obj) {
                if (keysToRemove.includes(prop)) {
                    delete obj[prop];
                } else if (typeof obj[prop] === 'object' && obj[prop] !== null) {
                    deleteNestedKeys(obj[prop], keysToRemove);
                }
            }
        };
        deleteNestedKeys(jsonData, removeKeysList);

        // STRIP TEXT
        if (apiConfig.branding_mode === 'hidden') {
            const genericKeys = ["owner", "developer", "creator", "channel", "telegram", "credit", "copyright"];
            deleteNestedKeys(jsonData, genericKeys);
        }

        // TEXT REPLACEMENT
        let rawJson = JSON.stringify(jsonData);
        if (apiConfig.branding_mode === 'hidden') {
            rawJson = rawJson.replace(/@\w+|https?:\/\/[^\s"]+/g, ""); 
        }
        
        const replacers = apiConfig.replace_words || [];
        replacers.forEach(rw => {
            if (rw.target) {
                const searchRegex = new RegExp(rw.target, 'gi');
                rawJson = rawJson.replace(searchRegex, rw.replacement || "");
            }
        });

        const finalData = JSON.parse(rawJson);
        const output = { ...finalData, ...branding };

        if (pretty === 'true') {
            return res.setHeader('Content-Type', 'application/json').send(JSON.stringify(output, null, 4));
        }
        return res.status(200).json(output);

    } catch (error) {
        return res.status(500).json({ error: "Provider Timeout", message: "Upstream provider failed to respond in time." });
    }
}
