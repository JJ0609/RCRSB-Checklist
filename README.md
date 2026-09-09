# RCRSB Commissioning — GitHub Pages + shared sync

This is the RCRSB commissioning app adapted to run on GitHub Pages with
shared, persistent state (device checklists + punch list) backed by a
real SQLite database (Turso), through a security proxy (Cloudflare Worker).

## What changed from the original artifact

The original file used `window.claude.use('db')` and
`window.claude.use('downloads')` — APIs that only exist inside Claude's
own artifact runtime. Outside that environment (i.e. on GitHub Pages)
those calls silently do nothing, which is why the original would still
render but never sync or export.

- **Sync**: replaced with calls to a small Cloudflare Worker API
  (`/api/state`, `/api/check`, `/api/punch`, `/api/punch/toggle`), which
  is the only thing that talks to the actual database.
- **CSV export**: replaced with a plain in-browser download (`Blob` +
  temporary link click) — works in any browser, no special API needed.
- Everything else — the UI, the device list, local caching, optimistic
  updates while offline — is unchanged.

## Architecture

```
Browser (GitHub Pages)  --->  Cloudflare Worker  --->  Turso (SQLite)
     no DB credentials         holds the real token      actual data
     only 4 fixed endpoints    only 4 fixed operations
```

This is the hardened version discussed previously: the browser never
holds anything capable of running arbitrary SQL. It can only call four
narrow operations, each of which runs one fixed, parameterized query:

| Endpoint | What it's allowed to do |
|---|---|
| `GET /api/state?project=rcrsb` | Read all checklist + punch rows for that project |
| `POST /api/check` | Set one of `power`/`network`/`function` to `pass`/`fail`/`null` for one device |
| `POST /api/punch` | Insert a new punch item with a server-generated id |
| `POST /api/punch/toggle` | Flip a punch item between `open` and `resolved` |

Every input is validated against a whitelist (project id, check key,
check value, severity) or a length/format check before it touches the
database — there's no path from the browser to an arbitrary query.

## 1. Create the Turso database

```
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create rcrsb-commissioning
turso db show rcrsb-commissioning --url      # gives libsql://...
turso db tokens create rcrsb-commissioning   # gives the auth token
```

Use the `https://` version of the URL (swap the `libsql://` prefix).
The Worker creates the two tables automatically on first request, so no
manual schema step is required (`schema.sql` is included for reference).

## 2. Deploy the Cloudflare Worker

**Option A — dashboard (no CLI needed):**
1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Create Worker.
2. Give it a name (e.g. `rcrsb-commissioning-sync`), deploy the default, then click **Edit code**.
3. Replace the contents with `worker/index.js` from this package. Save & deploy.
4. Go to **Settings → Variables and Secrets** and add three **secret** variables:
   - `TURSO_DB_URL` — the `https://...turso.io` URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1
   - `ALLOWED_ORIGIN` — the exact origin your GitHub Pages site will be served from, e.g. `https://yourorg.github.io` (no trailing slash; comma-separate if you'll test from more than one origin, e.g. also `http://localhost:5500` while developing)
5. Note the Worker's URL, e.g. `https://rcrsb-commissioning-sync.yourname.workers.dev`.

**Option B — CLI (`wrangler`):**
```
cd worker
npx wrangler deploy
npx wrangler secret put TURSO_DB_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put ALLOWED_ORIGIN
```

## 3. Point the app at the Worker

In `config.js`, set:

```js
const SYNC_API_BASE = "https://rcrsb-commissioning-sync.yourname.workers.dev";
```

If you leave this as the placeholder, the app runs in **local-only mode**
(each device keeps its own copy in `localStorage`, matching the original
artifact's offline fallback behavior) — nothing breaks, it just won't
share state until you configure this.

## 4. Deploy to GitHub Pages

Push `index.html`, `style.css`, `config.js`, `devices.js`, `app.js`, and
`power-design-logo-white.png` to a repo (all in the same folder) and
enable Pages on it (Settings → Pages). The `worker/` folder is deployed
separately to Cloudflare and never ships to the browser.

## Security notes

- **The Turso token never reaches the browser.** It lives only in the
  Worker's encrypted environment variables. Anyone can view your
  GitHub Pages source and learn nothing that lets them touch the
  database directly.
- **CORS is locked to `ALLOWED_ORIGIN`.** Requests from other origins
  are rejected by the Worker.
- **Every write is whitelisted and parameterized** — a malicious or
  malformed request can flip a switch or add a punch item, and nothing
  else. It can't drop a table, read other projects' data, or run
  injected SQL.
- **Still open by design**: anyone with the page URL can toggle checks
  and add/resolve punch items, with no login — that matches what you
  asked for originally (anyone can view and change it).

### Further hardening, if you want it later

| Addition | What it adds | Effort |
|---|---|---|
| Cloudflare Turnstile before writes | Blocks scripted/bot abuse while staying invisible to real people | ~15–20 min |
| Cloudflare Rate Limiting Rules (needs a custom domain on the Worker, not just `*.workers.dev`) | Caps how fast one IP can hit the API | ~15 min |
| A per-tech access code (shared team password, not individual logins) | Cuts out randos who stumble on the URL, without building real auth | ~30 min |

None of these are in the current build — say the word if you want any
added, since each is a small, self-contained change to `worker/index.js`.

## Known limitation — no real-time push

The original used Firestore-style `onSnapshot` for instant updates.
Turso's HTTP API doesn't offer a push channel the same way, so this
version polls the Worker every 5 seconds (`SYNC_POLL_MS` in
`config.js`) instead. Your own edits still apply instantly (optimistic
UI) — only *other* people's changes take up to ~5 seconds to appear on
your screen.

## Files

```
index.html                     page structure only — rarely needs editing
style.css                      all visual styling
config.js                      the only file most people need to touch:
                                  SYNC_API_BASE, SYNC_POLL_MS
devices.js                     project device data — swap this out to
                                  commission a different project
app.js                         all the logic (rendering, sync, events)
power-design-logo-white.png    header logo
worker/index.js                Cloudflare Worker — the security proxy
worker/wrangler.toml           optional CLI deploy config
worker/schema.sql              reference schema (auto-created by the Worker)
```

The original was one 940-line HTML file with markup, data, config, and
logic all interleaved. It's now split so each kind of change touches
exactly one file:

| To change... | Edit... |
|---|---|
| Which Worker the app syncs to | `config.js` |
| The device list (new project, added/removed devices) | `devices.js` |
| Colors, fonts, spacing, layout | `style.css` |
| How something behaves (rendering, sync logic, new features) | `app.js` |
| The logo | replace `power-design-logo-white.png` |

All five files (plus the logo) need to be uploaded together to GitHub
Pages — `index.html` loads the others via `<link>` and `<script src>`,
so a missing file means a broken page, not a silent partial failure.

### Commissioning a new project

1. Run `ExtractData.py` against the new project's Info Sheet (see
   `CommissioningArtifactBuildNotes.txt` in the main project for that
   script's details).
2. Replace the contents of `devices.js` with the new `PROJECT_DEVICES`
   array. Keep the `const PROJECT_DEVICES = [...]` wrapper.
3. In `app.js`, the `PROJECTS` object still only has one entry
   (`"rcrsb"`) — for a second *simultaneous* project (not a replacement),
   add a new key there and give `devices.js` a second exported array.
   For simply switching which single project this deployment tracks,
   step 2 alone is enough.
4. Update `ALLOWED_PROJECTS` in `worker/index.js` if you add a new
   project key, then redeploy the Worker.

## Confidence note

The Worker's calls to Turso's HTTP (Hrana v2 pipeline) API are built
against Turso's documented request/response format, but this was not
tested against a live database from this environment (no network
access to turso.io here). Test the full round trip — toggle a check,
refresh, confirm it persisted — right after you wire up steps 1–3, and
check the Worker's logs (Cloudflare dashboard → your Worker → Logs) if
something doesn't come back as expected.
