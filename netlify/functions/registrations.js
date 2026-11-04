const { getStore, connectLambda } = require('@netlify/blobs');
const A = require('./_lib/auth');

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      if (i < 0) return [p, ''];
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    })
  );
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function getRegistrationsStore(event) {
  connectLambda(event);
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'registrations', siteID, token });
  }
  return getStore('registrations');
}

async function mailerHealth() {
  const url = process.env.APPROVAL_MAILER_URL || '';
  if (!url) return { ok: false, error: 'APPROVAL_MAILER_URL not set' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return { ok: !!data.ok, service: data.service, version: data.version || null };
    } catch (_) {
      return {
        ok: false,
        error: 'Google returned HTTP ' + resp.status + ' (web app not authorized / not public yet)',
      };
    }
  } catch (err) {
    return { ok: false, error: 'mailer unreachable: ' + (err && err.message) };
  } finally {
    clearTimeout(t);
  }
}

async function requireAdmin(event) {
  const s = await A.getSession(event);
  return !!(s && s.role === 'admin');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }

  if (!(await requireAdmin(event))) {
    return json(403, { error: 'Admin only' });
  }

  if (event.httpMethod === 'GET') {
    try {
      const store = getRegistrationsStore(event);
      const listed = await store.list();
      const blobs = (listed && listed.blobs) || [];
      const registrations = [];
      for (const b of blobs) {
        try {
          const data = await store.get(b.key, { type: 'json' });
          if (data && typeof data === 'object') registrations.push(A.publicUser(data));
        } catch (_) {}
      }
      registrations.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const mailer = await mailerHealth();
      return json(200, { registrations, mailer });
    } catch (err) {
      return json(500, { error: 'load failed', detail: String(err && err.message || err) });
    }
  }

  // Admin user actions: disable | enable | reset (issue one-time setup link, clears password)
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Invalid JSON' }); }
    const id = String(body.id || '').trim();
    const action = String(body.action || '');
    if (!id) return json(400, { error: 'id required' });
    const store = getRegistrationsStore(event);
    const rec = await store.get(id, { type: 'json' }).catch(() => null);
    if (!rec) return json(404, { error: 'Registration not found' });
    if (action === 'disable') {
      if (rec.status !== 'disabled') rec.statusBeforeDisable = rec.status;
      rec.status = 'disabled';
      rec.disabledAt = new Date().toISOString();
      rec.tokenVersion = (rec.tokenVersion || 0) + 1;
      delete rec.setupTokenHash; delete rec.setupExpires;
      await store.setJSON(id, rec);
      await A.logEvent(event, 'admin_disable', { email: rec.email, userId: id });
      return json(200, { ok: true, registration: A.publicUser(rec) });
    }
    if (action === 'enable') {
      rec.status = rec.statusBeforeDisable === 'pending' ? 'pending' : 'approved';
      delete rec.disabledAt; delete rec.statusBeforeDisable;
      await store.setJSON(id, rec);
      await A.logEvent(event, 'admin_enable', { email: rec.email, userId: id });
      return json(200, { ok: true, registration: A.publicUser(rec) });
    }
    if (action === 'reset') {
      if (rec.status === 'disabled') return json(400, { error: 'Enable the user first' });
      delete rec.passwordHash;
      rec.tokenVersion = (rec.tokenVersion || 0) + 1;
      const link = await A.issueSetupLink(event, rec);
      await A.logEvent(event, 'admin_reset', { email: rec.email, userId: id });
      return json(200, { ok: true, link, expires: rec.setupExpires, registration: A.publicUser(rec) });
    }
    return json(400, { error: 'Unknown action' });
  }

  if (event.httpMethod === 'DELETE') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return json(400, { error: 'Invalid JSON' });
    }
    const id = String(body.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    try {
      const store = getRegistrationsStore(event);
      await store.delete(id);
      return json(200, { ok: true, id });
    } catch (err) {
      return json(500, { error: 'delete failed', detail: String(err && err.message || err) });
    }
  }

  return json(405, { error: 'Method not allowed' });
};
