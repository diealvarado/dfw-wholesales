const A = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method not allowed' });

  let email = '', password = '';
  try {
    const b = JSON.parse(event.body || '{}');
    email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    password = String(b.password || '').slice(0, 300);
  } catch (_) { return A.json(400, { error: 'Invalid JSON' }); }
  if (!password) return A.json(400, { error: 'Password required' });

  const rlId = email || '(no-email)';
  const wait = await A.rlBlocked(event, rlId);
  if (wait > 0) {
    await A.logEvent(event, 'login_blocked', { email: email || null });
    return A.json(429, { error: 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' }, { 'Retry-After': String(wait) });
  }

  const fail = async (reason, status, msg) => {
    await A.rlFail(event, rlId);
    await A.logEvent(event, 'login_fail', { email: email || null, reason });
    return A.json(status || 401, { error: msg || 'Invalid email or password' });
  };
  const ok = async (role, user, extra) => {
    await A.rlClear(event, rlId);
    await A.logEvent(event, 'login_success', Object.assign({ role, email: user ? user.email : (email || null), userId: user ? user.id : null }, extra || {}));
    return A.json(200, { ok: true, role }, { 'Set-Cookie': A.sessionCookie(A.newSession(role, user)) });
  };

  const adminPw = process.env.ADMIN_PASSWORD || '';
  // Admin keeps password-only login (email optional / ignored).
  if (adminPw && A.safeEqual(password, adminPw)) return ok('admin', null);

  if (!email) {
    const sitePw = process.env.SITE_PASSWORD || '';
    if (A.legacyActive() && sitePw && A.safeEqual(password, sitePw)) return ok('investor', null, { legacy: true });
    return fail('no_email', 401, 'Enter your email and password');
  }

  let user;
  try { user = await A.findUserByEmail(event, email); } catch (err) {
    return A.json(500, { error: 'Login unavailable', detail: String(err && err.message || err) });
  }
  if (!user || !user.passwordHash) {
    // Approved investor without a personal password yet: allow shared password during transition.
    const sitePw = process.env.SITE_PASSWORD || '';
    if (user && user.status === 'approved' && A.legacyActive() && sitePw && A.safeEqual(password, sitePw)) {
      return ok('investor', user, { legacy: true });
    }
    return fail(user ? 'no_password_set' : 'unknown_email');
  }
  if (!A.checkPassword(password, user.passwordHash)) return fail('bad_password');
  if (user.status === 'pending') {
    await A.logEvent(event, 'login_fail', { email, reason: 'pending' });
    return A.json(403, { error: 'Your access request is still pending approval.' });
  }
  if (user.status !== 'approved') {
    await A.logEvent(event, 'login_fail', { email, reason: 'disabled' });
    return A.json(403, { error: 'This account is disabled. Contact Alvacom Homes.' });
  }

  try {
    const st = A.store(event, 'registrations');
    const fresh = await st.get(user.id, { type: 'json' });
    if (fresh) {
      fresh.lastLogin = new Date().toISOString();
      fresh.loginCount = (fresh.loginCount || 0) + 1;
      await st.setJSON(user.id, fresh);
    }
  } catch (_) {}
  return ok('investor', user);
};
