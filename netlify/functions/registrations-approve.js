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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  if (cookies.alvacom_auth !== 'admin') {
    return json(403, { error: 'Admin only' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON' });
  }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'id required' });

  const mailerUrl = process.env.APPROVAL_MAILER_URL || '';
  const approvalSecret = process.env.APPROVAL_SECRET || '';
  const sitePassword = process.env.SITE_PASSWORD || '';
  if (!mailerUrl || !approvalSecret) {
    return json(500, { error: 'Approval mailer not configured' });
  }
  if (!sitePassword) {
    return json(500, { error: 'SITE_PASSWORD not configured' });
  }

  try {
    const store = getRegistrationsStore(event);
    const record = await store.get(id, { type: 'json' });
    if (!record || typeof record !== 'object') {
      return json(404, { error: 'Registration not found' });
    }

    const mailResp = await fetch(mailerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: approvalSecret,
        to: record.email,
        name: record.name,
        password: sitePassword,
      }),
    });
    let mailJson = null;
    try { mailJson = await mailResp.json(); } catch (_) {}
    if (!mailResp.ok || (mailJson && mailJson.ok === false)) {
      return json(502, {
        error: 'Failed to send approval email',
        detail: (mailJson && mailJson.error) || ('mailer HTTP ' + mailResp.status),
      });
    }

    record.status = 'approved';
    record.approvedAt = new Date().toISOString();
    await store.setJSON(id, record);
    return json(200, { ok: true, registration: record });
  } catch (err) {
    console.error('approve', err && err.message);
    return json(500, {
      error: 'Approve failed',
      detail: String(err && err.message || err),
    });
  }
};
