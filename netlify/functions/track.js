// Logged-in clients report deal views / searches. Fire-and-forget.
const A = require('./_lib/auth');
const TYPES = { deal_view: 1, search: 1, filter: 1 };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method not allowed' });
  const s = await A.getSession(event);
  if (!s) return A.json(401, { error: 'Unauthorized' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (_) { return A.json(400, { error: 'Invalid JSON' }); }
  const type = String(b.type || '');
  if (!TYPES[type]) return A.json(400, { error: 'Bad type' });
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const data = { role: s.role, email: s.email, userId: s.userId, legacy: s.legacy || undefined };
  if (type === 'deal_view') { data.dealId = clip(b.dealId, 200); data.address = clip(b.address, 200); data.dealCity = clip(b.city, 80); }
  else data.query = clip(b.query, 120);
  await A.logEvent(event, type, data);
  return A.json(200, { ok: true });
};
