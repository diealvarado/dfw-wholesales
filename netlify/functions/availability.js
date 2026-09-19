const { getStore, connectLambda } = require('@netlify/blobs');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  };
}

async function loadOverrides(event) {
  try {
    connectLambda(event);
    const store = getStore({ name: 'availability', consistency: 'strong' });
    const data = await store.get('overrides', { type: 'json', consistency: 'strong' });
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    console.error('availability loadOverrides', err && err.message);
    return {};
  }
}

async function saveOverrides(event, overrides) {
  connectLambda(event);
  const store = getStore({ name: 'availability', consistency: 'strong' });
  await store.setJSON('overrides', overrides);
  // Read-after-write check (strong) so callers don't race eventual consistency
  const verify = await store.get('overrides', { type: 'json', consistency: 'strong' });
  if (!verify || verify[Object.keys(overrides).slice(-1)[0]] !== overrides[Object.keys(overrides).slice(-1)[0]]) {
    // Fallback: rewrite once if verify looks stale
    await store.setJSON('overrides', overrides);
  }
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
    const overrides = await loadOverrides(event);
    return json(200, { overrides });
  }

  if (event.httpMethod === 'POST') {
    if (role !== 'admin') {
      return json(403, { error: 'Admin only' });
    }
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return json(400, { error: 'Invalid JSON' });
    }
    const id = String(body.id || '').trim();
    if (!id) return json(400, { error: 'Missing id' });
    if (typeof body.available !== 'boolean') {
      return json(400, { error: 'available must be boolean' });
    }

    const overrides = await loadOverrides(event);
    overrides[id] = body.available;
    try {
      await saveOverrides(event, overrides);
    } catch (err) {
      console.error('availability save', err && err.message);
      return json(500, { error: 'Failed to save override' });
    }
    return json(200, { ok: true, id, available: body.available, overrides });
  }

  return json(405, { error: 'Method not allowed' });
};
