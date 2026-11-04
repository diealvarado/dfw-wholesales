// Public: redeem a one-time setup link (issued by admin) to set/reset a password.
const A = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method not allowed' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (_) { return A.json(400, { error: 'Invalid JSON' }); }
  const tok = String(b.token || '');
  const dot = tok.indexOf('.');
  const id = dot > 0 ? tok.slice(0, dot) : '';
  const raw = dot > 0 ? tok.slice(dot + 1) : '';
  const check = !!b.check;

  const wait = await A.rlBlocked(event, 'setup:' + id);
  if (wait > 0) return A.json(429, { error: 'Too many attempts. Try again later.' });

  const st = A.store(event, 'registrations');
  const rec = id && /^[\w-]{8,80}$/.test(id) ? await st.get(id, { type: 'json' }).catch(() => null) : null;
  const valid = rec && rec.setupTokenHash && raw && A.safeEqual(A.sha('setup:' + raw), rec.setupTokenHash) &&
    Date.parse(rec.setupExpires || 0) > Date.now() && rec.status !== 'disabled';
  if (!valid) {
    await A.rlFail(event, 'setup:' + id);
    return A.json(400, { error: 'This setup link is invalid or expired. Ask Alvacom Homes for a new one.' });
  }
  if (check) return A.json(200, { ok: true, email: rec.email, name: rec.name });

  const pwErr = A.passwordProblem(b.password);
  if (pwErr) return A.json(400, { error: pwErr });
  rec.passwordHash = A.hashPassword(b.password);
  rec.passwordSetAt = new Date().toISOString();
  rec.tokenVersion = (rec.tokenVersion || 0) + 1;
  delete rec.setupTokenHash; delete rec.setupExpires;
  await st.setJSON(rec.id, rec);
  await A.logEvent(event, 'password_set', { email: rec.email, userId: rec.id });

  if (rec.status === 'approved') {
    rec.lastLogin = new Date().toISOString();
    rec.loginCount = (rec.loginCount || 0) + 1;
    await st.setJSON(rec.id, rec);
    await A.logEvent(event, 'login_success', { role: 'investor', email: rec.email, userId: rec.id, via: 'setup' });
    return A.json(200, { ok: true, signedIn: true }, { 'Set-Cookie': A.sessionCookie(A.newSession('investor', rec)) });
  }
  return A.json(200, { ok: true, signedIn: false, message: 'Password saved. You can sign in once your access is approved.' });
};
