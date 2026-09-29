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

async function notifyAdmins(record) {
  const url = process.env.APPROVAL_MAILER_URL || '';
  const secret = process.env.APPROVAL_SECRET || '';
  if (!url || !secret) return { ok: false, error: 'mailer not configured' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'notify',
        secret,
        name: record.name,
        email: record.email,
        phone: record.phone,
        createdAt: record.createdAt,
      }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || 'mailer error' };
    } catch (_) {
      return { ok: false, error: 'mailer HTTP ' + resp.status + ' (not authorized?)' };
    }
  } catch (err) {
    return { ok: false, error: 'mailer unreachable: ' + (err && err.message) };
  } finally {
    clearTimeout(t);
  }
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

    // Notify admins directly via the Apps Script mailer. Netlify form email
    // notifications are skipped when Netlify flags a submission as spam, so we
    // don't rely on them. Never blocks or fails the registration.
    const notify = await notifyAdmins(record);
    try {
      record.notified = notify.ok;
      if (!notify.ok) record.notifyError = notify.error;
      await store.setJSON(id, record);
    } catch (_) {}

    return json(200, { ok: true, id });
  } catch (err) {
    console.error('register', err && err.message);
    return json(500, {
      error: 'Failed to save registration',
      detail: String(err && err.message || err),
    });
  }
};
