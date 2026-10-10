/**
 * Netlify Function: proxy between the website and the Google Apps Script backend.
 *
 * The browser only ever talks to /api. The Apps Script web-app URL and its secret key
 * stay here, in Netlify environment variables, and are never sent to the browser.
 *
 * Environment variables (Netlify > Site configuration > Environment variables):
 *   APPS_SCRIPT_URL  the Apps Script "Web app" URL (ends with /exec)         [required]
 *   SCRIPT_KEY       must equal CONFIG.ACCESS_KEY in Code.gs                  [required]
 *   LOGIN_KEY        what staff type on the login screen                      [optional]
 *                    (if not set, the login key is the same as SCRIPT_KEY)
 */
const crypto = require('crypto');

const ACTIONS = new Set(['ping', 'generate', 'save', 'print', 'list']);
const MAX_BODY = 20000;          // bytes; real requests are well under 2 KB
const UPSTREAM_TIMEOUT_MS = 25000;

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

// Compare secrets without leaking their length or content through timing.
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });

  const url = process.env.APPS_SCRIPT_URL;
  const scriptKey = process.env.SCRIPT_KEY;
  const loginKey = process.env.LOGIN_KEY || scriptKey;
  if (!url || !scriptKey) {
    console.error('APPS_SCRIPT_URL or SCRIPT_KEY is not set.');
    return reply(500, { ok: false, error: 'The server is not configured yet.' });
  }

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) return reply(413, { ok: false, error: 'Request too large.' });

  let req;
  try { req = JSON.parse(raw || '{}'); } catch (e) { return reply(400, { ok: false, error: 'Bad request.' }); }
  if (!req || typeof req !== 'object') return reply(400, { ok: false, error: 'Bad request.' });

  if (typeof req.key !== 'string' || !safeEqual(req.key, loginKey)) {
    await sleep(500); // slows down guessing
    return reply(401, { ok: false, error: 'Invalid access key.' });
  }
  if (!ACTIONS.has(req.action)) return reply(400, { ok: false, error: 'Unknown action.' });

  // Forward only the fields the backend understands, with the real secret added here.
  const payload = { key: scriptKey, action: req.action };
  ['qty', 'vin', 'details', 'reason', 'limit'].forEach(k => { if (req[k] !== undefined) payload[k] = req[k]; });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow', // Apps Script answers with a redirect to the real result
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') {
      console.error('Unexpected reply from Apps Script, status', res.status);
      return reply(502, { ok: false, error: 'The backend returned an unexpected reply.' });
    }
    return reply(200, data);
  } catch (err) {
    console.error('Upstream error:', err && err.name);
    const msg = err && err.name === 'AbortError'
      ? 'The backend took too long. Check the Records tab before retrying.'
      : 'Cannot reach the backend.';
    return reply(504, { ok: false, error: msg });
  } finally {
    clearTimeout(timer);
  }
};
