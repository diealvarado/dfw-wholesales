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

const SITE_URL = 'https://dfw-wholesales.netlify.app';
const SUBJECT = 'Your Alvacom Homes access is approved';

function approvalBody(name, password) {
  return 'Hi ' + (name || 'Investor') + ',\n\n' +
    'Your request for access to Alvacom Homes Off-Market has been approved.\n\n' +
    'Site: ' + SITE_URL + '\n' +
    'Investor access password: ' + password + '\n\n' +
    'Sign in with this password to view available off-market listings.\n\n' +
    '— Alvacom Homes\n';
}

/** POST to the Apps Script mailer; normalizes Google's HTML error pages. */
async function callMailer(url, payload) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, error: 'Mailer unreachable: ' + (err && err.message) };
  }
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (data && typeof data === 'object') {
    return data.ok ? { ok: true, data } : { ok: false, error: data.error || 'Mailer error' };
  }
  if (/access denied|you need access|authorization/i.test(text) || resp.status === 403 || resp.status === 401) {
    return {
      ok: false,
      error: 'Approval mailer is not authorized (Google returned HTTP ' + resp.status +
        '). rentlmgt@gmail.com must open the Apps Script editor, run doGet and click Allow.',
    };
  }
  return { ok: false, error: 'Mailer returned HTTP ' + resp.status + ' (non-JSON)' };
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
  const manual = body.manual === true;
  if (!id) return json(400, { error: 'id required' });

  const mailerUrl = process.env.APPROVAL_MAILER_URL || '';
  const approvalSecret = process.env.APPROVAL_SECRET || '';
  const sitePassword = process.env.SITE_PASSWORD || '';
  if (!sitePassword) {
    return json(500, { error: 'SITE_PASSWORD not configured' });
  }

  try {
    const store = getRegistrationsStore(event);
    const record = await store.get(id, { type: 'json' });
    if (!record || typeof record !== 'object') {
      return json(404, { error: 'Registration not found' });
    }

    if (manual) {
      // Admin will send the email personally (mailer down or preferred).
      record.status = 'approved';
      record.approvedAt = new Date().toISOString();
      record.emailed = false;
      await store.setJSON(id, record);
      const mailto = 'mailto:' + encodeURIComponent(record.email) +
        '?subject=' + encodeURIComponent(SUBJECT) +
        '&body=' + encodeURIComponent(approvalBody(record.name, sitePassword));
      return json(200, { ok: true, manual: true, registration: record, mailto });
    }

    if (!mailerUrl || !approvalSecret) {
      return json(500, { error: 'Approval mailer not configured (APPROVAL_MAILER_URL / APPROVAL_SECRET)' });
    }

    const result = await callMailer(mailerUrl, {
      action: 'approve',
      secret: approvalSecret,
      to: record.email,
      name: record.name,
      password: sitePassword,
    });
    if (!result.ok) {
      record.lastEmailError = result.error;
      record.lastEmailAttemptAt = new Date().toISOString();
      await store.setJSON(id, record);
      return json(502, { error: 'Failed to send approval email', detail: result.error });
    }

    record.status = 'approved';
    record.approvedAt = new Date().toISOString();
    record.emailed = true;
    delete record.lastEmailError;
    await store.setJSON(id, record);
    return json(200, { ok: true, registration: record, mailer: result.data });
  } catch (err) {
    console.error('approve', err && err.message);
    return json(500, { error: 'Approve failed', detail: String(err && err.message || err) });
  }
};
