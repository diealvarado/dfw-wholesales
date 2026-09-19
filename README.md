# Alvacom Homes · Off-Market

Private DFW off-market map for **Alvacom Homes** (shared-password gate).

- Brand: **Alvacom Homes** (primary) with smaller **Off-Market** label
- Auth: Netlify Functions set an `HttpOnly` cookie (`alvacom_auth=admin|investor`)
- Data: Google Sheet CSV fetched **server-side only** (URL never in frontend JS)
- **Available** = deal appears in the last-10-calendar-days feed (no extra sheet column)
- Map + list views + property one-pager
- Investor role: wholesaler/sender hidden; admin role: wholesaler shown
- Free Netlify plan only (no paid add-ons required)

## Deploy (Netlify)

1. Import / link this GitHub repo to your Netlify site (`diealvarado/dfw-wholesales`).
2. Publish directory = site root (`.`). Build command = empty.
3. Functions directory = `netlify/functions` (also set in `netlify.toml`).
4. Set environment variables (Site settings → Environment variables):

| Variable | Purpose |
|----------|---------|
| `SHEET_CSV_URL` | Published Google Sheet CSV URL (server-only) |
| `SITE_PASSWORD` | Shared password for **investor** role |
| `ADMIN_PASSWORD` | Password for **admin** role (sees wholesaler) |

Example `SHEET_CSV_URL` (do **not** put this in frontend code):

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vSEqr1ov1Iqat1Ep3KSvFn1vbM8Ti-rRT9fhZOiPOGvkHnKi6Aub8RcJ5BZCOfLN_uKk8seu5bZfx2u/pub?gid=0&single=true&output=csv
```

5. Redeploy after setting env vars.

### API routes

- `POST /api/login` — `{ "password": "..." }` → sets cookie
- `POST /api/logout` (or GET) — clears cookie
- `GET /api/deals` — requires cookie; returns `{ role, deals }`

### Optional second gate

Cloudflare Access (or similar) can sit in front of the Netlify site as an optional extra gate. Configure that outside this repo; passwords above remain the in-app role gate.

### Available definition

A listing is **Available: Yes** when its **Email Date** falls within the last **10 calendar days**. There is no separate “Available” column on the sheet.
