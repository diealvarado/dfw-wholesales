// Shared auth / users / events helpers (Netlify Functions + Netlify Blobs only).
const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const COOKIE = 'alvacom_session';
const SESSION_TTL_S = 7 * 24 * 3600;
// Shared investor password keeps working until this date (transition only).
const LEGACY_UNTIL = process.env.LEGACY_SHARED_PASSWORD_UNTIL || '2026-12-05';

function store(event, name) {
  try { connectLambda(event); } catch (_) {}
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token, consistency: 'strong' });
  return getStore({ name, consistency: 'strong' });
}

function json(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {}),
    body: JSON.stringify(body),
  };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) { out[k] = p.slice(i + 1).trim(); }
  });
  return out;
}

function hdr(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || '';
}

/** HMAC key: SESSION_SECRET if set, otherwise derived from existing server-only secrets. */
function sessionKey() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const material = [process.env.ADMIN_PASSWORD, process.env.APPROVAL_SECRET, process.env.SITE_PASSWORD]
    .map((s) => s || '').join('\u0000');
  if (!material.replace(/\u0000/g, '')) throw new Error('No secret available for sessions');
  return crypto.createHmac('sha256', material).update('alvacom-session-v1').digest('hex');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
  const [body, sig] = tok.split('.');
  const expect = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  const a = Buffer.from(sig || ''); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || !p.exp || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}

function sessionCookie(payload) {
  return `${COOKIE}=${signToken(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}
const clearCookies = [
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  'alvacom_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
];

function newSession(role, user) {
  const now = Math.floor(Date.now() / 1000);
  const p = { r: role, iat: now, exp: now + SESSION_TTL_S };
  if (user) { p.u = user.id; p.e = user.email; p.v = user.tokenVersion || 0; }
  return p;
}

/**
 * Returns {role, email, userId} or null. Investor sessions tied to a user are
 * re-checked against the registrations store (disabled / reset => logged out).
 */
async function getSession(event) {
  const cookies = parseCookies(hdr(event, 'cookie'));
  let p;
  try { p = verifyToken(cookies[COOKIE]); } catch (_) { return null; }
  if (!p || (p.r !== 'admin' && p.r !== 'investor')) return null;
  if (p.r === 'investor' && p.u) {
    try {
      const u = await store(event, 'registrations').get(p.u, { type: 'json' });
      if (!u || u.status !== 'approved' || (u.tokenVersion || 0) !== (p.v || 0)) return null;
    } catch (_) { return null; }
  }
  if (p.r === 'investor' && !p.u && !legacyActive()) return null;
  return { role: p.r, email: p.e || null, userId: p.u || null, legacy: p.r === 'investor' && !p.u };
}

function legacyActive() {
  return !!process.env.SITE_PASSWORD && Date.now() < new Date(LEGACY_UNTIL + 'T23:59:59-06:00').getTime();
}

// ---- passwords (scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$8$1$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function checkPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB, hashB] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const expect = Buffer.from(hashB, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(saltB, 'base64'), expect.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(got, expect);
  } catch (_) { return false; }
}
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters';
  if (s.length > 200) return 'Password is too long';
  return null;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- users (registrations store) ----
async function listUsers(event) {
  const st = store(event, 'registrations');
  const listed = await st.list();
  const blobs = (listed && listed.blobs) || [];
  const out = await Promise.all(blobs.map((b) => st.get(b.key, { type: 'json' }).catch(() => null)));
  return out.filter((x) => x && typeof x === 'object');
}
/** Best record for an email: approved+password first, then newest. */
async function findUserByEmail(event, email) {
  const e = String(email || '').trim().toLowerCase();
  const all = (await listUsers(event)).filter((u) => String(u.email || '').toLowerCase() === e);
  const rank = (u) => (u.status === 'approved' ? 4 : u.status === 'pending' ? 2 : 0) + (u.passwordHash ? 1 : 0);
  all.sort((a, b) => rank(b) - rank(a) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return all[0] || null;
}
function publicUser(u) {
  const o = Object.assign({}, u);
  delete o.passwordHash; delete o.setupTokenHash;
  o.hasPassword = !!u.passwordHash;
  o.setupPending = !!(u.setupTokenHash && u.setupExpires && Date.parse(u.setupExpires) > Date.now());
  return o;
}

// ---- request context ----
function clientIp(event) {
  return String(hdr(event, 'cf-connecting-ip') || hdr(event, 'x-nf-client-connection-ip') ||
    String(hdr(event, 'x-forwarded-for')).split(',')[0] || '').trim();
}
function geo(event) {
  let g = {};
  try { const raw = hdr(event, 'x-nf-geo'); if (raw) g = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (_) {}
  const city = (g.city || '').trim();
  const region = (g.subdivision && g.subdivision.code) || '';
  const country = (g.country && g.country.code) || hdr(event, 'cf-ipcountry') || '';
  return { city, region, country };
}
function shortUA(event) {
  const ua = String(hdr(event, 'user-agent'));
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node|bot|spider/i.test(ua) ? 'Bot/script' : 'Other';
  return br + ' / ' + os;
}

// ---- events ----
function chicagoDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
async function logEvent(event, type, data) {
  try {
    const now = new Date();
    const g = geo(event);
    const ev = Object.assign({
      type, ts: now.toISOString(),
      ipHash: sha('ip:' + clientIp(event)).slice(0, 12),
      city: g.city, region: g.region, country: g.country, ua: shortUA(event),
    }, data || {});
    const key = 'ev/' + chicagoDay(now) + '/' + now.getTime() + '-' + crypto.randomBytes(4).toString('hex');
    await store(event, 'events').setJSON(key, ev);
  } catch (err) { console.error('logEvent', err && err.message); }
}

// ---- rate limiting (failed logins) ----
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_EMAIL_IP = 5;
const RL_MAX_IP = 20;
const RL_MAX_EMAIL = 10; // per email, any IP (defeats rotating IPs)
async function rlState(event, keys) {
  const st = store(event, 'auth-ratelimit');
  const cutoff = Date.now() - RL_WINDOW_MS;
  const res = {};
  for (const k of keys) {
    const d = await st.get(k, { type: 'json' }).catch(() => null);
    res[k] = ((d && d.fails) || []).filter((t) => t > cutoff);
  }
  return res;
}
function rlKeys(event, email) {
  const ip = clientIp(event);
  const e = String(email || '').toLowerCase();
  return { pair: 'p/' + sha(e + '|' + ip), ip: 'i/' + sha(ip), em: 'e/' + sha(e) };
}
async function rlBlocked(event, email) {
  const k = rlKeys(event, email);
  const s = await rlState(event, [k.pair, k.ip, k.em]);
  const now = Date.now();
  if (s[k.em].length >= (email === '(no-email)' ? 30 : RL_MAX_EMAIL)) return Math.ceil((s[k.em][0] + RL_WINDOW_MS - now) / 1000);
  if (s[k.pair].length >= RL_MAX_EMAIL_IP) return Math.ceil((s[k.pair][0] + RL_WINDOW_MS - now) / 1000);
  if (s[k.ip].length >= RL_MAX_IP) return Math.ceil((s[k.ip][0] + RL_WINDOW_MS - now) / 1000);
  return 0;
}
async function rlFail(event, email) {
  const k = rlKeys(event, email);
  const st = store(event, 'auth-ratelimit');
  const s = await rlState(event, [k.pair, k.ip, k.em]);
  await st.setJSON(k.em, { fails: s[k.em].concat(Date.now()).slice(-50) });
  await st.setJSON(k.pair, { fails: s[k.pair].concat(Date.now()).slice(-50) });
  await st.setJSON(k.ip, { fails: s[k.ip].concat(Date.now()).slice(-50) });
}
async function rlClear(event, email) {
  try { const k = rlKeys(event, email); const st = store(event, 'auth-ratelimit'); await st.delete(k.pair); await st.delete(k.em); } catch (_) {}
}

// ---- one-time password setup links ----
// Public links always use the branded proxy URL (Netlify sees its own host behind Cloudflare).
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_SITE_URL || 'https://alvacomhomes.com/offmarket').replace(/\/+$/, '');
const SITE_BASE = PUBLIC_BASE_URL;
async function issueSetupLink(event, record, days) {
  const raw = crypto.randomBytes(24).toString('base64url');
  record.setupTokenHash = sha('setup:' + raw);
  record.setupExpires = new Date(Date.now() + (days || 7) * 86400000).toISOString();
  await store(event, 'registrations').setJSON(record.id, record);
  return SITE_BASE + '/?setup=' + encodeURIComponent(record.id + '.' + raw);
}

module.exports = {
  PUBLIC_BASE_URL,
  issueSetupLink,
  store, json, parseCookies, hdr, sessionCookie, clearCookies, newSession, getSession, legacyActive, LEGACY_UNTIL,
  hashPassword, checkPassword, passwordProblem, safeEqual, sha, listUsers, findUserByEmail, publicUser,
  clientIp, geo, shortUA, chicagoDay, logEvent, rlBlocked, rlFail, rlClear, verifyToken, signToken,
};
