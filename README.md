# Alvacom Homes · Off-Market

Private DFW off-market map for **Alvacom Homes** (shared-password gate).

- Brand: **Alvacom Homes** (primary) with smaller **Off-Market** label
- Auth: Netlify Functions set an `HttpOnly` cookie (`alvacom_auth=admin|investor`)
- Data: Google Sheet CSV fetched **server-side only** (URL never in frontend JS)
- Default **Available** = deal appears in the last-10-calendar-days feed
- **Admin availability overrides** persist in Netlify Blobs (free) — checkbox on map popup, list card, and one-pager
- **City / ZIP search** filters map markers and list (combined with DFW focus filter)
- Map + list views + property one-pager
- Investor role: wholesaler/sender hidden; admin role: wholesaler shown
- Free Netlify plan only (no paid add-ons required)

## Deploy (Netlify)

1. Import / link this GitHub repo to your Netlify site (`diealvarado/dfw-wholesales`).
2. Publish directory = site root (`.`). Build command = empty (Netlify installs `package.json` deps for Functions).
3. Functions directory = `netlify/functions` (also set in `netlify.toml`).
4. Set environment variables (Site settings → Environment variables):

| Variable | Purpose |
|----------|---------|
| `SHEET_CSV_URL` | Published Google Sheet CSV URL (server-only) |
| `SITE_PASSWORD` | Shared password for **investor** role |
| `ADMIN_PASSWORD` | Password for **admin** role (sees wholesaler; can toggle Available) |

Do **not** put `SHEET_CSV_URL` or passwords in frontend code or commit them to the repo.

5. Redeploy after setting env vars.

### API routes

- `POST /api/login` — `{ "password": "..." }` → sets cookie
- `POST /api/logout` (or GET) — clears cookie
- `GET /api/deals` — requires cookie; returns `{ role, deals }` with stable `id` and `available` (override-aware)
- `GET /api/availability` — requires cookie; returns `{ overrides: { [dealId]: boolean } }`
- `POST /api/availability` — **admin only**; body `{ "id": "...", "available": true|false }` → persists to Blobs store `availability` key `overrides`

### Availability

1. In-window deals (Email Date within last **10 calendar days**) default to **Available: Yes**.
2. Admins can uncheck **Available** on the pin popup, list card, or one-pager. That override is stored in **Netlify Blobs** (store `availability`, key `overrides`) and survives reloads/deploys.
3. Investors see Available / Unavailable text only (no checkbox). Unavailable pins and list rows are visually muted/badged.

### Search

Header **Search city or ZIP** filters map + list (case-insensitive, partial match on city **or** ZIP). Combines with the existing ALLOWED_CITIES / “Show all cities” control. Empty search = no extra filter.

### Optional second gate

Cloudflare Access (or similar) can sit in front of the Netlify site as an optional extra gate. Configure that outside this repo; passwords above remain the in-app role gate.
