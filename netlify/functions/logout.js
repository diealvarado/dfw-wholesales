const A = require('./_lib/auth');
exports.handler = async (event) => {
  return {
    statusCode: event.httpMethod === 'OPTIONS' ? 204 : 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    multiValueHeaders: { 'Set-Cookie': A.clearCookies },
    body: event.httpMethod === 'OPTIONS' ? '' : JSON.stringify({ ok: true }),
  };
};
