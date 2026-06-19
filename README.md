# Buche

A personal, Goodreads-style book tracker. Plain static site — vanilla
HTML/CSS/JS, no build step, no framework, no npm. Data lives in a Google
Sheet; the site reads it as CSV; a Google Apps Script Web App writes back.

Live target: `jcs3.com/Buche/`.

---

## Architecture

```
Browser (index.html / books.css / books.js)
   │  READ  ── gviz CSV ──►  Google Sheet  ◄── WRITE ── Apps Script (Code.gs)
   │                                              (doPost, shared-secret guard)
   └─ SEARCH/COVERS ──►  Google Books + Open Library  (keyless, public)
```

- **READ** — the page fetches the Sheet as CSV from the gviz endpoint
  (sheet shared "anyone with link / viewer"). No auth.
- **WRITE** — `Code.gs` is a Web App `doPost`, guarded by a shared-secret
  string that must match in `Code.gs` and `books.js`. The client POSTs with
  `Content-Type: text/plain;charset=utf-8` to dodge a CORS preflight Apps
  Script can't answer; the script `JSON.parse`s the raw body.
- **COVERS** — if a book has an ISBN →
  `https://covers.openlibrary.org/b/isbn/{ISBN}-M.jpg?default=false`
  (the `?default=false` forces a 404 the client catches via `onerror`);
  else a `cover_override` URL; else a text placeholder.

## Schema (column order — `id` FIRST)

```
id, title, author, isbn, status, rating, started, finished,
notes, cover_override, year_pub, genre, carousel
```

- **id** — opaque stable key, `b000`, `b001`, … Server-generated, never
  reused, never reordered. All edits/deletes/enrichment write back BY ID.
- **status** — canonical `reading | read | tbr | dnf`; a forgiving normalizer
  accepts synonyms (Finished/Done → read, etc.).
- **rating** — integer 1–5 or blank.
- **started / finished** — stored `YYYY-MM-DD`; the normalizer also accepts
  `M/YYYY`, `YYYY`, `M/D/YYYY`.
- **carousel** — themed shelf, a **comma-separated multi-tag** (a book may sit
  on several shelves). Orthogonal to status.
- A 14th column, **`enrich_tried`**, is appended by the enrichment trigger as
  a tracking timestamp. It is not part of the canonical 13 and is created
  automatically.

## Features

- Live add (Google Books + Open Library search, merged + de-duped).
- **Background enrichment** — hourly Apps Script trigger backfills
  `isbn` / `cover_override` / `year_pub` by ID, blanks only, idempotent.
- **Carousels** — themed horizontal shelves, first-class, orthogonal to the
  status grid.
- **Edit & delete on the page** — unlocked by stable ids.
- **Bulk import** — paste/upload CSV, TSV, a Markdown table, or one book per
  line (`Title — Author`, `Title by Author`); dedup on title+author; one
  atomic write. `.xlsx` is read via SheetJS, lazy-loaded from a CDN only when
  an Excel file is chosen.
- **Cover-screenshot intake** — `tools/cover-vision.html` (see below).

## Files

| File | Where it runs |
|------|---------------|
| `index.html`, `books.css`, `books.js` | the static site (upload to host) |
| `Code.gs` | Google Apps Script, **bound to the Sheet** (not on the site) |
| `tools/cover-vision.html` | a Claude.ai artifact / local tool, **not** the public site |
| `data/books_master_v2.csv` | a snapshot of the library (seed/backup) |

---

## Setup

See [`SETUP.md`](./SETUP.md) for full deploy steps. In short:

1. **Apps Script** — open the Sheet → Extensions → Apps Script → paste
   `Code.gs` → set `SHARED_SECRET` → Deploy as Web App (Execute as: Me /
   Access: Anyone) → copy the `/exec` URL.
2. **books.js** — set `WRITE_URL` (the `/exec` URL) and `SHARED_SECRET`
   (the *same* string). They must match `Code.gs` exactly.
3. **Upload** `index.html`, `books.css`, `books.js` to the host.
4. **Enrichment (optional)** — in Apps Script, run `installEnrichTrigger`
   once to arm the hourly cover/ISBN backfill.

### Security note

`SHARED_SECRET` is the only thing standing between the internet and write
access to your Sheet. **Keep the placeholder in this repo.** Set the real
value only in your deployed copy, and never commit it. If you prefer, split
the two constants into a `config.local.js` (already in `.gitignore`) and load
it before `books.js`.

> `data/books_master_v2.csv` contains your reading list (titles/authors only,
> no secrets). Remove it from the repo if you'd rather not publish it.

---

## Cover-screenshot intake (`tools/cover-vision.html`)

This tool uses the **in-artifact Anthropic API**, which only works inside the
Claude.ai sandbox (it has a keyless proxied endpoint). It is **not** part of
the public deploy — a public static page has no API key, and hardcoding one
would leak it. Run it as a Claude artifact (or anywhere the in-artifact API is
available), set its `WRITE_URL` / `SHARED_SECRET`, then: drop a cover image →
Claude reads title/author → confirm against Google Books / Open Library →
approve → it writes through the same endpoint.

## Scope / anti-goals

No real backend or database (Sheets is the store, correct into the low
thousands of rows). No junction tables (carousels are comma-separated tags).
No real-time. No accounts/auth. Schema columns are never reordered or renamed.

## Testing

Logic is checked with Node + jsdom (no framework). The `sim*.js` harnesses in
the development workspace cover id-generation, the write endpoint
(add/update/delete/addBulk), the enrichment selection/idempotency, carousel
grouping, the edit-diff, and the import parsers/dedup. Every `.js` is verified
with `node --check`.
