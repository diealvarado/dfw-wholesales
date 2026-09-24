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

/** Minimal RFC4180-ish CSV parser (no npm deps). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => String(h || '').trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => !String(c || '').trim())) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] != null ? String(cells[idx]) : '';
    });
    out.push(obj);
  }
  return out;
}

function clean(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return !s || s.toUpperCase() === 'N/A' ? '' : s;
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

function findKey(keys, aliases) {
  const cleaned = keys.map((k) => ({
    raw: k,
    norm: String(k).replace(/[^a-zA-Z]/g, '').toLowerCase(),
  }));
  for (const a of aliases) {
    const hit = cleaned.find((c) => c.norm === a);
    if (hit) return hit.raw;
  }
  return undefined;
}

/** Stable deal id — must match frontend makeId. */
function makeId(deal) {
  const base = deal.emailId || (deal.address + '|' + deal.emailDate + '|' + deal.price);
  return String(base).toLowerCase();
}

async function loadOverrides(event) {
  try {
    connectLambda(event);
    const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
    const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
    const store = (siteID && token)
      ? getStore({ name: 'availability', siteID, token })
      : getStore('availability');
    const data = await store.get('overrides', { type: 'json' });
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    console.error('deals loadOverrides', err && err.message);
    return {};
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const role = cookies.alvacom_auth;
  if (role !== 'admin' && role !== 'investor') {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sheetUrl = process.env.SHEET_CSV_URL;
  if (!sheetUrl) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'SHEET_CSV_URL not configured' }),
    };
  }

  let csvText;
  try {
    const resp = await fetch(sheetUrl, {
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!resp.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch sheet (' + resp.status + ')' }),
      };
    }
    csvText = await resp.text();
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Sheet fetch error: ' + (err && err.message) }),
    };
  }

  const rawRows = parseCsv(csvText);
  if (!rawRows.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ role, deals: [] }) };
  }

  const keys = Object.keys(rawRows[0] || {});
  const k = {
    address: findKey(keys, ['address']),
    date: findKey(keys, ['emaildate', 'date']),
    city: findKey(keys, ['city']),
    state: findKey(keys, ['state']),
    zip: findKey(keys, ['zipcode', 'zip']),
    price: findKey(keys, ['price']),
    sender: findKey(keys, ['sender']),
    beds: findKey(keys, ['bedroom', 'bedrooms', 'beds']),
    baths: findKey(keys, ['bathroom', 'bathrooms', 'baths']),
    garage: findKey(keys, ['garage']),
    sqft: findKey(keys, ['sqft', 'squarefeet']),
    year: findKey(keys, ['yearbuild', 'yearbuilt', 'year']),
    comments: findKey(keys, ['comments', 'comment']),
    subject: findKey(keys, ['emailsubject', 'subject']),
    emailId: findKey(keys, ['emailid', 'messageid', 'id']),
    description: findKey(keys, ['description']),
    photosUrl: findKey(keys, ['photoslink', 'photosurl', 'photos']),
    imageUrl: findKey(keys, ['imageurl', 'image', 'imgurl', 'thumbnail']),
  };

  if (!k.address || !k.date) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Sheet missing Address or Email Date column',
        headers: keys,
      }),
    };
  }

  const overrides = await loadOverrides(event);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);
  cutoff.setHours(0, 0, 0, 0);

  // Scan ALL rows in the 10-day window. Do NOT early-break on "older streak":
  // after reparses the sheet is often not strictly newest-first (updates-in-place
  // leave older rows above newer inserts), which previously capped /api/deals at ~2.
  const deals = [];
  for (const row of rawRows) {
    const address = clean(row[k.address]);
    if (!address) continue;
    const emailDateRaw = clean(row[k.date]);
    const emailDate = parseDate(emailDateRaw);
    if (!emailDate || emailDate < cutoff) {
      continue;
    }

    const deal = {
      address,
      city: k.city ? clean(row[k.city]) : '',
      state: (k.state && clean(row[k.state])) || 'TX',
      zip: k.zip ? clean(row[k.zip]) : '',
      price: k.price ? clean(row[k.price]) : '',
      beds: k.beds ? clean(row[k.beds]) : '',
      baths: k.baths ? clean(row[k.baths]) : '',
      garage: k.garage ? clean(row[k.garage]) : '',
      sqft: k.sqft ? clean(row[k.sqft]) : '',
      year: k.year ? clean(row[k.year]) : '',
      comments: k.comments ? clean(row[k.comments]) : '',
      subject: k.subject ? clean(row[k.subject]) : '',
      emailDate: emailDateRaw,
      emailId: k.emailId ? clean(row[k.emailId]) : '',
    };

    deal.id = makeId(deal);
    if (Object.prototype.hasOwnProperty.call(overrides, deal.id)) {
      deal.available = !!overrides[deal.id];
    } else {
      deal.available = true;
    }

    if (role === 'admin') {
      deal.sender = k.sender ? clean(row[k.sender]) : '';
      const description = k.description ? clean(row[k.description]) : '';
      const photosUrl = k.photosUrl ? clean(row[k.photosUrl]) : '';
      const imageUrl = k.imageUrl ? clean(row[k.imageUrl]) : '';
      if (description) deal.description = description;
      if (photosUrl) deal.photosUrl = photosUrl;
      if (imageUrl) deal.imageUrl = imageUrl;
    } else {
      deal.sender = null;
      // Investors never see deals marked unavailable by admin
      if (deal.available === false) continue;
    }

    deals.push(deal);
  }

  // One pin per address+zip: keep newest Email Date; prefer non-empty price on ties
  function normKey(d) {
    const a = String(d.address || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const z = String(d.zip || '').replace(/\D/g, '').trim();
    return a + '|' + z;
  }
  function priceScore(p) {
    const s = String(p || '').trim();
    if (!s) return 0;
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return !isNaN(n) && n > 0 ? 2 : 1;
  }
  const byKey = new Map();
  for (const d of deals) {
    const key = normKey(d);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, d);
      continue;
    }
    const dDate = parseDate(d.emailDate);
    const pDate = parseDate(prev.emailDate);
    const dMs = dDate ? dDate.getTime() : 0;
    const pMs = pDate ? pDate.getTime() : 0;
    if (dMs > pMs) {
      byKey.set(key, d);
    } else if (dMs === pMs && priceScore(d.price) > priceScore(prev.price)) {
      byKey.set(key, d);
    }
  }
  const deduped = Array.from(byKey.values());

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ role, deals: deduped }),
  };
};
