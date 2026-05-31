export default async function handler(req, res) {
    const startTime = Date.now();
    
    // 1. Set standard JSON headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const host = req.headers.host || 'localhost';
    const urlObj = new URL(req.url, `https://${host}`);
    const pathSlug = urlObj.pathname.replace(/^\/+|\/+$/g, '');

    const { key, api: queryApi, pretty, ...extraParams } = req.query;
    const api = (pathSlug && pathSlug !== 'api') ? pathSlug : queryApi;

    // ⚠️ PHP HOSTING DOMAIN ⚠️
    const PHP_BACKEND_URL = "https://tdnapis.gt.tc/info/verify.php";
    const BRIDGE_SECRET = "LOFZ_SECRET_5588";

    // ERROR 1: Missing Parameters
    if (!key || !api) {
        return res.status(400).json({
            error: "Authentication Failed",
            message: "You must provide a valid 'key' and an API slug.",
            _provider_info: {
                developer: "@YourTelegramID",
                official_channel: "@LofzAI_Telegram"
            }
        });
    }

    try {
        const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

        const verifyReq = await fetch(PHP_BACKEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ secret: BRIDGE_SECRET, key, api, ip: clientIp })
        });

        let verifyData;
        try {
            verifyData = await verifyReq.json();
        } catch (e) {
            // ERROR 2: Master Database Down
            return res.status(500).json({
                error: "System Error",
                message: "Unable to connect to master database. The host may be offline."
            });
        }

        // ERROR 3: PHP Database Rules
        if (verifyData.error) {
            return res.status(403).json({
                error: "Access Denied",
                message: verifyData.error
            });
        }

        const qParam = verifyData.query_param || 'query';
        const mainQueryValue = extraParams[qParam] ? encodeURIComponent(extraParams[qParam]) : '';

        // ERROR 4: Blank Query
        if (!mainQueryValue) {
            const errResponse = {
                error: "Missing Query Parameter",
                message: `No value provided for '${qParam}'. Please include a valid query in the URL.`
            };
            if (verifyData.branding && Object.keys(verifyData.branding).length > 0) {
                errResponse._provider_info = {
                    developer: verifyData.branding.developer,
                    official_channel: verifyData.branding.channel
                };
            }
            return res.status(400).json(errResponse);
        }

        let fetchUrl = verifyData.target_url;
        if (fetchUrl.includes('[QUERY]')) {
            fetchUrl = fetchUrl.replace('[QUERY]', mainQueryValue);
        }

        if (verifyData.forward_all) {
            try {
                const fetchUrlObj = new URL(fetchUrl);
                for (const k in extraParams) {
                    if (k === qParam && verifyData.target_url.includes('[QUERY]')) continue;
                    fetchUrlObj.searchParams.append(k, extraParams[k]);
                }
                fetchUrl = fetchUrlObj.toString();
            } catch (e) {
                // Silent fail
            }
        }

        let upstreamRes;
        try {
            upstreamRes = await fetch(fetchUrl);
        } catch (e) {
            // ERROR 5: Vendor Timeout
            return res.status(502).json({
                error: "Upstream Error",
                message: "The vendor connection timed out."
            });
        }

        // ---------------------------------------------------------
        // SMART TEXT DETECTOR (JSON vs Plain Text errors)
        // ---------------------------------------------------------
        const rawText = await upstreamRes.text();
        let data;

        try {
            data = JSON.parse(rawText);
            if (typeof data !== 'object' || data === null) {
                throw new Error("Response is primitive string");
            }
        } catch (e) {
            // ERROR 6: Vendor returned text (like "Not Found")
            const cleanText = rawText.replace(/(^"|"$)/g, '').trim();
            const isHtml = cleanText.startsWith('<') || cleanText.toLowerCase().includes('<!doctype');

            const dynamicMessage = (!isHtml && cleanText.length > 0 && cleanText.length < 150)
                ? cleanText
                : "The upstream data provider returned an invalid format. Ensure your query is correct.";

            const errResponse = {
                error: "Vendor API Error",
                message: dynamicMessage
            };

            if (verifyData.branding && Object.keys(verifyData.branding).length > 0) {
                errResponse._provider_info = {
                    developer: verifyData.branding.developer,
                    official_channel: verifyData.branding.channel
                };
            }

            return res.status(upstreamRes.status === 404 ? 404 : 502).json(errResponse);
        }
        // ---------------------------------------------------------

        // Watermark Stripper
        const keysToRemove = verifyData.remove_keys || [];
        const cleanData = (obj) => {
            if (Array.isArray(obj)) return obj.map(cleanData);
            if (obj !== null && typeof obj === 'object') {
                for (let k in obj) {
                    if (keysToRemove.includes(k)) delete obj[k];
                    else obj[k] = cleanData(obj[k]);
                }
            }
            return obj;
        };
        data = cleanData(data);

        // Word Replacer
        const replaceWords = verifyData.replace_words || {};
        if (Object.keys(replaceWords).length > 0) {
            const applyReplaceWords = (obj) => {
                if (Array.isArray(obj)) return obj.map(applyReplaceWords);
                if (obj !== null && typeof obj === 'object') {
                    for (let k in obj) {
                        obj[k] = applyReplaceWords(obj[k]);
                    }
                } else if (typeof obj === 'string') {
                    let newVal = obj;
                    for (let search in replaceWords) {
                        if (!search) continue;
                        let replace = replaceWords[search];
                        newVal = newVal.replace(new RegExp(search, 'gi'), replace);
                    }
                    return newVal;
                }
                return obj;
            };
            data = applyReplaceWords(data);
        }

        // Branding
        const branding = verifyData.branding;
        if (branding && Object.keys(branding).length > 0) {
            data._provider_info = {
                developer: branding.developer,
                official_channel: branding.channel
            };
        }

        // Rate Limits Headers
        if (verifyData.limits && verifyData.usage) {
            if (verifyData.limits.daily > 0) {
                res.setHeader('X-RateLimit-Limit-Daily', verifyData.limits.daily);
                res.setHeader('X-RateLimit-Remaining-Daily', Math.max(0, verifyData.limits.daily - verifyData.usage.daily_count));
            }
            if (verifyData.limits.monthly > 0) {
                res.setHeader('X-RateLimit-Limit-Monthly', verifyData.limits.monthly);
                res.setHeader('X-RateLimit-Remaining-Monthly', Math.max(0, verifyData.limits.monthly - verifyData.usage.monthly_count));
            }
        }

        const execTime = Date.now() - startTime;
        res.setHeader('X-Execution-Time', `${execTime}ms`);

        if (pretty === 'true' || pretty === '1') {
            return res.status(200).send(JSON.stringify(data, null, 4));
        }

        return res.status(200).json(data);

    } catch (err) {
        // ERROR 7: Absolute Fallback
        return res.status(500).json({
            error: "Gateway Edge Error",
            message: "A critical connection failure occurred."
        });
    }
}
