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

function getBlobStore(event) {
  connectLambda(event);
  // Prefer explicit credentials if present (more reliable across function runtimes)
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'availability', siteID, token });
  }
  return getStore('availability');
}

async function loadOverrides(event) {
  const store = getBlobStore(event);
  const data = await store.get('overrides', { type: 'json' });
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

async function saveOverrides(event, overrides) {
  const store = getBlobStore(event);
  await store.setJSON('overrides', overrides);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const role = cookies.alvacom_auth;
  if (role !== 'admin' && role !== 'investor') {
    return json(401, { error: 'Unauthorized' });
  }

  if (event.httpMethod === 'GET') {
    try {
      const overrides = await loadOverrides(event);
      return json(200, {
        overrides,
        diag: {
          hasSite: Boolean(process.env.BLOBS_SITE_ID || process.env.SITE_ID),
          hasToken: Boolean(process.env.BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN),
        },
      });
    } catch (err) {
      return json(500, { error: 'load failed', detail: String(err && err.message || err) });
    }
  }

  if (event.httpMethod === 'POST') {
    if (role !== 'admin') return json(403, { error: 'Admin only' });
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return json(400, { error: 'Invalid JSON' });
    }
    const id = String(body.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    if (typeof body.available !== 'boolean') {
      return json(400, { error: 'available must be boolean' });
    }
    try {
      const overrides = await loadOverrides(event);
      overrides[id] = body.available;
      await saveOverrides(event, overrides);
      const verify = await loadOverrides(event);
      return json(200, { ok: true, id, available: body.available, overrides: verify });
    } catch (err) {
      return json(500, {
        error: 'Failed to save override',
        detail: String(err && err.message || err),
        stack: String(err && err.stack || '').slice(0, 800),
      });
    }
  }

  return json(405, { error: 'Method not allowed' });
};
