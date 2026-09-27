# beli-recs

Private backend for Warner's Beli restaurant workflows, deployed to Vercel as
`beli-recs` (production: `https://beli-recs.vercel.app`).

## Endpoints

- `GET /api/recs` — ranked restaurant recommendations: the user's Beli
  bookmarks first, then Beli platform trending for the requested neighborhood,
  with hours, open-at-time status, and live reservation slots/platforms.
- `POST /api/bookmark` — write a "Want to Try" bookmark to the user's Beli
  account. Body: `name` (required), `city` (optional), `dry_run` (optional).
  Only exact/near-exact normalized name matches are written; anything ambiguous
  returns `ambiguous` with candidates and writes nothing.

Both endpoints require `Authorization: Bearer <API_KEY>` (the `API_KEY` env
var). Beli credentials come from `BELI_EMAIL` / `BELI_PASSWORD` env vars
(Beli accepts either an email or a phone number as the login id).

## Local tooling

- `deploy.py` — deploy to Vercel via the REST API (inlines `api/`, `lib/`,
  `package.json`).
- `bin/beli` (in the `beli` skill) — CLI for recommendations.
- `beli_eats_watch.py` — daily pipeline: pulls new @beli_eats Instagram posts,
  extracts restaurant names from captions, and bookmarks confident matches via
  `POST /api/bookmark`. State: `state/beli_eats_seen.json`.

## Deploy

```bash
python3 deploy.py
```

Env vars required on Vercel: `BELI_EMAIL`, `BELI_PASSWORD`, `API_KEY`.
