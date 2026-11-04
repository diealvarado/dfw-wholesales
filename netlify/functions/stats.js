// Admin-only visitor stats from the 'events' blob store (last 30 days, America/Chicago days).
const A = require('./_lib/auth');

async function pMap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function loadDay(st, day, today) {
  // Closed days are compacted into one blob so later loads are a single read.
  if (day !== today) {
    const c = await st.get('daily/' + day, { type: 'json' }).catch(() => null);
    if (Array.isArray(c)) return c;
  }
  const listed = await st.list({ prefix: 'ev/' + day + '/' });
  const keys = ((listed && listed.blobs) || []).map((b) => b.key);
  const evs = (await pMap(keys, 40, (k) => st.get(k, { type: 'json' }).catch(() => null))).filter(Boolean);
  if (day !== today) { try { await st.setJSON('daily/' + day, evs); } catch (_) {} }
  return evs;
}

exports.handler = async (event) => {
  const s = await A.getSession(event);
  if (!s || s.role !== 'admin') return A.json(403, { error: 'Admin only' });
  const days = Math.min(90, Math.max(1, parseInt((event.queryStringParameters || {}).days, 10) || 30));
  const st = A.store(event, 'events');
  const today = A.chicagoDay(new Date());
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(A.chicagoDay(new Date(Date.now() - i * 86400000)));
  const uniqDays = Array.from(new Set(dayList));
  const perDay = await pMap(uniqDays, 6, (d) => loadDay(st, d, today));

  let users = [];
  try { users = (await A.listUsers(event)).map(A.publicUser); } catch (_) {}
  const userBy = {};
  users.forEach((u) => { userBy[String(u.email || '').toLowerCase()] = u; });

  const now = Date.now();
  const daily = [];
  const per = {}; // email -> stats
  const deals = {};
  const failed = [];
  const recent = [];
  const searches = {};
  const act7 = new Set(), act30 = new Set();
  let legacyLogins = 0;

  uniqDays.forEach((day, idx) => {
    const evs = perDay[idx] || [];
    const row = { day, logins: 0, fails: 0, investors: 0, views: 0 };
    const dayUsers = new Set();
    evs.forEach((e) => {
      const em = String(e.email || '').toLowerCase();
      const isInv = e.role === 'investor';
      const ident = em || (e.legacy ? 'shared-password:' + e.ipHash : '');
      if (e.type === 'login_success') {
        row.logins++;
        if (e.legacy) legacyLogins++;
        if (isInv && ident) dayUsers.add(ident);
      }
      if (e.type === 'login_fail' || e.type === 'login_blocked') {
        row.fails++;
        failed.push({ ts: e.ts, email: e.email || '', reason: e.reason || e.type, city: e.city, region: e.region, country: e.country, ua: e.ua, ipHash: e.ipHash });
      }
      if (e.type === 'deal_view') {
        row.views++;
        if (e.role === 'investor') {
          const d = deals[e.dealId] || (deals[e.dealId] = { dealId: e.dealId, address: e.address, city: e.dealCity, views: 0, viewers: new Set() });
          d.views++; if (ident) d.viewers.add(ident);
        }
      }
      if (e.type === 'search' && e.query && isInv) searches[e.query.toLowerCase()] = (searches[e.query.toLowerCase()] || 0) + 1;
      if (isInv && ident && (e.type === 'login_success' || e.type === 'deal_view' || e.type === 'search')) {
        const t = Date.parse(e.ts);
        if (now - t <= 7 * 86400000) act7.add(ident);
        if (now - t <= 30 * 86400000) act30.add(ident);
        const p = per[ident] || (per[ident] = { email: em || ('(shared password · ' + ([e.city, e.region].filter(Boolean).join(', ') || e.ipHash) + ')'), logins: 0, views: 0, dealSet: new Set(), lastSeen: '', lastCity: '' });
        if (e.type === 'login_success') p.logins++;
        if (e.type === 'deal_view') { p.views++; p.dealSet.add(e.dealId); }
        if (!p.lastSeen || e.ts > p.lastSeen) { p.lastSeen = e.ts; p.lastCity = [e.city, e.region, e.country].filter(Boolean).join(', '); }
      }
      if (e.type !== 'deal_view' && e.type !== 'search') recent.push(e);
    });
    row.investors = dayUsers.size;
    daily.push(row);
  });

  // Include every registered investor in the per-user table, even with no activity yet.
  users.forEach((u) => {
    const em = String(u.email || '').toLowerCase();
    if (!per[em]) per[em] = { email: em, logins: 0, views: 0, dealSet: new Set(), lastSeen: '', lastCity: '' };
  });
  const perUser = Object.values(per).map((p) => {
    const u = userBy[p.email] || {};
    return { email: p.email, name: u.name || '', status: u.status || (p.email.startsWith('(') ? 'shared' : 'unknown'),
      hasPassword: !!u.hasPassword, lastLogin: u.lastLogin || '', totalLogins: u.loginCount || 0,
      logins: p.logins, views: p.views, dealsViewed: p.dealSet.size, lastSeen: p.lastSeen, lastCity: p.lastCity };
  }).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)) || b.logins - a.logins);

  const topDeals = Object.values(deals).map((d) => ({ dealId: d.dealId, address: d.address, city: d.city, views: d.views, viewers: d.viewers.size }))
    .sort((a, b) => b.views - a.views).slice(0, 25);
  failed.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  recent.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const topSearches = Object.entries(searches).map(([q, n]) => ({ query: q, count: n })).sort((a, b) => b.count - a.count).slice(0, 15);

  return A.json(200, {
    days, today, daily,
    activeInvestors7d: act7.size, activeInvestors30d: act30.size,
    totals: { logins: daily.reduce((a, r) => a + r.logins, 0), fails: failed.length, views: daily.reduce((a, r) => a + r.views, 0), legacyLogins },
    users: { total: users.length, approved: users.filter((u) => u.status === 'approved').length,
      approvedNoPassword: users.filter((u) => u.status === 'approved' && !u.hasPassword).length,
      pending: users.filter((u) => u.status === 'pending').length, disabled: users.filter((u) => u.status === 'disabled').length },
    perUser, topDeals, topSearches,
    failed: failed.slice(0, 100),
    recent: recent.slice(0, 50).map((e) => ({ ts: e.ts, type: e.type, email: e.email || '', role: e.role || '', reason: e.reason || '', legacy: !!e.legacy, city: [e.city, e.region, e.country].filter(Boolean).join(', '), ua: e.ua })),
    legacySharedPasswordUntil: A.legacyActive() ? A.LEGACY_UNTIL : null,
  });
};
