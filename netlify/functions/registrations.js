const { getStore, connectLambda } = require('@netlify/blobs');

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

function requireAdmin(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  return cookies.alvacom_auth === 'admin';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }

  if (!requireAdmin(event)) {
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
          if (data && typeof data === 'object') registrations.push(data);
        } catch (_) {}
      }
      registrations.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return json(200, { registrations });
    } catch (err) {
      return json(500, { error: 'load failed', detail: String(err && err.message || err) });
    }
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
