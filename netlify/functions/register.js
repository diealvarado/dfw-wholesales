const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');

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

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validPhone(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON' });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();

  if (!name || name.length < 2) return json(400, { error: 'Full name is required' });
  if (!validEmail(email)) return json(400, { error: 'Valid email is required' });
  if (!validPhone(phone)) return json(400, { error: 'Valid phone is required' });

  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const record = {
    id,
    name,
    email,
    phone,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  try {
    const store = getRegistrationsStore(event);
    await store.setJSON(id, record);
    return json(200, { ok: true, id });
  } catch (err) {
    console.error('register', err && err.message);
    return json(500, {
      error: 'Failed to save registration',
      detail: String(err && err.message || err),
    });
  }
};
