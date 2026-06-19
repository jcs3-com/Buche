# Buche — setup & deploy

Four moving parts: `index.html` / `books.css` / `books.js` on your host, and
`Code.gs` inside Google Apps Script (bound to the Sheet).

## 1 — Deploy the write endpoint (`Code.gs`)

1. Open your Sheet → **Extensions → Apps Script**.
2. Delete the default `myFunction` and paste all of **`Code.gs`**.
3. At the top, set `SHARED_SECRET` to any random string (e.g. `g7$kPq2_xL9mZ`).
   Remember it — the same value goes into `books.js`.
4. Confirm `SHEET_NAME` matches your tab (default `Sheet1`).
5. Save → **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy → authorize (click through the "unverified" warning — it's your
     own script asking to edit your own Sheet).
6. Copy the **Web app URL** ending in `/exec`.
7. Sanity check: open that `/exec` URL in a browser. You should see
   `{"ok":true,"message":"Book tracker write endpoint is live."}`

**Re-deploying after editing `Code.gs`:** Deploy → **Manage deployments** →
edit (pencil) → Version: **New version** → Deploy. The `/exec` URL stays the
same. (Editing the code alone does not update the live endpoint.)

## 2 — Wire up `books.js`

At the top of **`books.js`**:

```js
const WRITE_URL = "https://script.google.com/macros/s/AKfy.../exec"; // from step 6
const SHARED_SECRET = "g7$kPq2_xL9mZ"; // EXACT same string as in Code.gs
```

They must match `Code.gs` exactly or every write returns `Unauthorized`.

## 3 — Upload

Upload `index.html`, `books.css`, `books.js` to your host. Visit
`/index.html`. (`Code.gs` lives in Google, not on your site.)

## 4 — Arm the enrichment trigger (optional but recommended)

In the Apps Script editor:

1. Select **`enrichBatch`** → **Run** once. Authorize UrlFetch + Sheets. Watch
   the Execution log — it should fill ISBNs/years for up to 15 rows and create
   an `enrich_tried` column.
2. Run it two more times to clear the initial backlog (15 + 15 + 10 ≈ 3 runs
   for 40 books).
3. Select **`installEnrichTrigger`** → **Run** once to arm the hourly timer.
   Use **`removeEnrichTriggers`** to disarm.

Rate budget: ≤2 external calls/row (Google Books, then Open Library on a miss)
→ ≤30/run → ≤720/day worst case, well under UrlFetchApp's 20,000/day quota.

## Using it

- **Add** — `+ Add a book`, search, pick a match (or add manually), set
  status/rating/dates/notes/genre/carousels, **Save**.
- **Edit / delete** — hover a card (always visible on touch); edit reuses the
  form and writes only changed fields; delete asks to confirm.
- **Bulk import** — `⇪ Bulk import`, paste or upload, **Preview** (duplicates
  flagged and unchecked), **Import selected**.
- **Cover screenshot** — run `tools/cover-vision.html` as a Claude artifact
  (see README for why it's separate), set its `WRITE_URL` / `SHARED_SECRET`.

## Notes

- The forgiving normalizer means legacy rows (`Finished`, `1/2026`) display
  correctly; new writes use clean canonical formats.
- Apps Script free quota is 20,000 calls/day — you will not hit it.
- Sheets is the right store into the low thousands of rows. Revisit only past
  ~5,000 rows or when you need relational queries.
