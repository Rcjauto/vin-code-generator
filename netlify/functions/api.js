/**
 * Netlify Function: proxy between the website and the Google Apps Script backend.
 *
 * The browser only ever talks to /api. The Apps Script web-app URL and its secret key
 * stay here, in Netlify environment variables, and are never sent to the browser.
 *
 * Login:  the browser sends ID + password once. The Apps Script checks them against the
 *         "Users" tab and says which product the user belongs to. This function then issues a
 *         signed session token (valid for a few hours). The browser keeps only the token,
 *         never the password.
 * Every later request carries the token. This function checks the signature and expiry, takes
 * the user and product from the token (never from the browser), and the Apps Script checks
 * again that the user is still active and the password has not changed.
 *
 * Environment variables (Netlify > Site configuration > Environment variables):
 *   APPS_SCRIPT_URL  the Apps Script "Web app" URL (ends with /exec)         [required]
 *   SCRIPT_KEY       must equal CONFIG.ACCESS_KEY in Code.gs (24+ chars)      [required]
 *   SESSION_SECRET   random text used to sign session tokens (32+ chars)      [required]
 *   SESSION_HOURS    how long a login lasts, 1 to 24 (default 8)              [optional]
 *
 * To log everybody out at once, change SESSION_SECRET and redeploy.
 */
const crypto = require('crypto');

const ACTIONS = new Set(['ping', 'generate', 'save', 'print', 'list']);
const MAX_BODY = 20000;          // bytes; real requests are well under 2 KB
const MAX_CRED = 100;            // longest ID or password accepted
const UPSTREAM_TIMEOUT_MS = 25000;
const BAD_LOGIN = 'Invalid ID or password.';
const SESSION_ENDED = 'Session expired. Please log in again.';

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- session tokens ---------- */
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest();

function makeToken(claims, secret) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + sign(body, secret).toString('base64url');
}

function readToken(token, secret) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = sign(parts[0], secret);
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || typeof c.i !== 'string' || typeof c.p !== 'string' || typeof c.v !== 'string' ||
      typeof c.e !== 'number' || Date.now() > c.e) return null;
  return c;
}

/* ---------- call the Apps Script ---------- */
async function callBackend(url, payload) {
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
      return { error: reply(502, { ok: false, error: 'The backend returned an unexpected reply.' }) };
    }
    return { data };
  } catch (err) {
    console.error('Upstream error:', err && err.name);
    const msg = err && err.name === 'AbortError'
      ? 'The backend took too long. Check the Records tab before retrying.'
      : 'Cannot reach the backend.';
    return { error: reply(504, { ok: false, error: msg }) };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });

  const url = process.env.APPS_SCRIPT_URL;
  const scriptKey = process.env.SCRIPT_KEY;
  const secret = process.env.SESSION_SECRET;
  if (!url || !scriptKey || !secret || scriptKey.length < 24 || secret.length < 32) {
    console.error('APPS_SCRIPT_URL, SCRIPT_KEY (24+ chars) or SESSION_SECRET (32+ chars) is missing.');
    return reply(500, { ok: false, error: 'The server is not configured yet.' });
  }
  const hours = Math.min(Math.max(Number(process.env.SESSION_HOURS) || 8, 1), 24);

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) return reply(413, { ok: false, error: 'Request too large.' });

  let req;
  try { req = JSON.parse(raw || '{}'); } catch (e) { return reply(400, { ok: false, error: 'Bad request.' }); }
  if (!req || typeof req !== 'object') return reply(400, { ok: false, error: 'Bad request.' });

  /* ---------- login ---------- */
  if (req.action === 'login') {
    if (typeof req.id !== 'string' || typeof req.password !== 'string' ||
        !req.id.trim() || !req.password || req.id.length > MAX_CRED || req.password.length > MAX_CRED) {
      await sleep(500);
      return reply(401, { ok: false, error: BAD_LOGIN });
    }
    const site = typeof req.site === 'string' ? req.site.slice(0, 40) : '';
    const out = await callBackend(url, { key: scriptKey, action: 'login', id: req.id, password: req.password, site });
    if (out.error) return out.error;
    const d = out.data;
    if (d.ok !== true || !d.product || typeof d.ver !== 'string') {
      await sleep(500); // slows down guessing
      return reply(401, { ok: false, error: typeof d.error === 'string' ? d.error : BAD_LOGIN });
    }
    const expires = Date.now() + hours * 3600 * 1000;
    const token = makeToken({ i: req.id.trim().toLowerCase(), p: d.product.id, v: d.ver, e: expires }, secret);
    return reply(200, { ok: true, product: d.product, token, expiresAt: expires });
  }

  /* ---------- every other action needs a valid session ---------- */
  if (!ACTIONS.has(req.action)) return reply(400, { ok: false, error: 'Unknown action.' });
  const claims = readToken(req.token, secret);
  if (!claims) return reply(401, { ok: false, code: 'AUTH', error: SESSION_ENDED });

  // User and product come from the signed token, never from the browser's own fields.
  const payload = { key: scriptKey, action: req.action, id: claims.i, product: claims.p, ver: claims.v };
  ['qty', 'vin', 'details', 'reason', 'limit'].forEach(k => { if (req[k] !== undefined) payload[k] = req[k]; });

  const out = await callBackend(url, payload);
  if (out.error) return out.error;
  if (out.data.code === 'AUTH') return reply(401, { ok: false, code: 'AUTH', error: SESSION_ENDED });
  return reply(200, out.data);
};
