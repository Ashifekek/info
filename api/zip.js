const archiver = require('archiver');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { PassThrough } = require('stream');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { bot_token, chat_id, accounts, order_id, caption, secret } = req.body;

    // Basic auth
    const VALID_SECRET = process.env.API_SECRET || 'alofz_zip_2026';
    if (secret !== VALID_SECRET) {
      return res.status(403).json({ error: 'Invalid secret' });
    }

    if (!bot_token || !chat_id || !accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ error: 'Missing: bot_token, chat_id, accounts[]' });
    }

    // Create ZIP in memory
    const zipBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('data', (chunk) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      // Add each session as a .session file
      // Also create an info.txt with phone + 2FA details
      let infoLines = [`===== BULK ORDER: ${order_id} =====`, `Accounts: ${accounts.length}`, '=' .repeat(50), ''];

      accounts.forEach((acc, i) => {
        const phone = (acc.phone || `Account_${i + 1}`).replace('+', '').replace(' ', '');
        const session = acc.session || '';
        const password = acc.password || '';

        // Add .session file
        if (session) {
          archive.append(session, { name: `${phone}.session` });
        }

        // Add to info file
        infoLines.push(`--- Account #${i + 1} ---`);
        infoLines.push(`Phone: ${acc.phone || phone}`);
        if (password) infoLines.push(`2FA Password: ${password}`);
        infoLines.push(`Session File: ${phone}.session`);
        infoLines.push('');
      });

      // Add info.txt
      archive.append(infoLines.join('\n'), { name: 'INFO.txt' });

      archive.finalize();
    });

    // Send ZIP to Telegram via Bot API
    const form = new FormData();
    form.append('chat_id', chat_id);
    form.append('caption', caption || `📦 ${accounts.length} session files | ${order_id}`);
    form.append('document', zipBuffer, {
      filename: `${order_id}.zip`,
      contentType: 'application/zip'
    });

    const tgResp = await fetch(`https://api.telegram.org/bot${bot_token}/sendDocument`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });

    const tgData = await tgResp.json();

    if (tgData.ok) {
      const fileId = tgData.result?.document?.file_id || '';
      return res.status(200).json({
        ok: true,
        file_id: fileId,
        message: `ZIP sent: ${accounts.length} .session files`
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: tgData.description || 'Telegram API error'
      });
    }

  } catch (err) {
    console.error('ZIP API Error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
};
