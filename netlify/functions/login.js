exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let password = '';
  try {
    const body = JSON.parse(event.body || '{}');
    password = String(body.password || '');
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const adminPw = process.env.ADMIN_PASSWORD || '';
  const sitePw = process.env.SITE_PASSWORD || '';

  let role = null;
  if (adminPw && password === adminPw) role = 'admin';
  else if (sitePw && password === sitePw) role = 'investor';
  else {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
  }

  const cookie =
    `alvacom_auth=${role}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Set-Cookie': cookie,
    },
    body: JSON.stringify({ ok: true, role }),
  };
};
