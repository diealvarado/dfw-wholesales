# DFW Wholesales Map

Static map of recent DFW wholesale deals. Reads a published Google Sheet CSV and plots the last 10 days on Leaflet.

## Live data

Sheet CSV (public publish):

https://docs.google.com/spreadsheets/d/e/2PACX-1vSEqr1ov1Iqat1Ep3KSvFn1vbM8Ti-rRT9fhZOiPOGvkHnKi6Aub8RcJ5BZCOfLN_uKk8seu5bZfx2u/pub?gid=0&single=true&output=csv

## Deploy (Netlify, free)

1. In Netlify, **Add new site → Import an existing project → GitHub**.
2. Pick this repo (`dfw-wholesales`).
3. Publish directory: site root (leave build command empty). Netlify will serve `index.html`.
4. Optional: keep the existing custom domain / site name `dfw-wholesales`.

Edits to `index.html` on `main` redeploy automatically after Netlify is linked.

## Filters

Default mode is **Target DFW Area**: cities in the allowlist, or ZIP codes starting with `75` / `76`. Toggle **Show All Cities** for every deal in the last 10 days.
