/* Apps Script backend for the jcs3 book tracker  — V2
   =====================================================
   Bound to the Google Sheet (Extensions -> Apps Script). NOT on the site.

   PHASE 0  — write endpoint:  doPost routes add | update | delete, all keyed
              by the stable `id` (b000, b001, …), never by row position.
   PHASE 1  — enrichment:      enrichBatch() backfills isbn / cover_override /
              year_pub from Google Books + Open Library, BY ID, blanks only.
   LAYER 2  — verified covers: enrichBatch() now VERIFIES that a real cover
              exists before trusting it (Open Library by ISBN, both ISBN
              forms; falls to a verified Google/OL cover URL written into
              cover_override only when OL is DEFINITIVELY empty), and replaces
              the write-once `enrich_tried` flag with a retry state machine so
              cover-less rows are revisited instead of stranded.

   DEPLOY (write endpoint):
     Save -> Deploy -> New deployment -> Web app ->
     Execute as: Me / Who has access: Anyone -> Deploy -> authorize ->
     copy the /exec URL into books.js (WRITE_URL).
   REDEPLOY after editing this file:
     Deploy -> Manage deployments -> edit (pencil) -> Version: New version ->
     Deploy. The /exec URL stays the same.

   SHARED_SECRET below MUST match SHARED_SECRET in books.js exactly.
   >>> This line is the ONE manual edit on overwrite: restore YOUR real secret
   >>> (the value already in books.js). Do NOT deploy with the CHANGE_ME stub. <<<
*/

const SHARED_SECRET = "CHANGE_ME_to_any_random_string_then_match_in_books_js";
const SHEET_NAME = "Sheet1";

/* Canonical schema — id FIRST. Order MUST match row-1 headers in the Sheet.
   This is exactly the 13 canonical columns. `enrich_tried` (Phase 1) is a
   separate tracking column appended AFTER carousel and is intentionally NOT
   in this array, so appendRow always writes exactly 13 aligned cells. */
const COLUMNS = [
  "id", "title", "author", "isbn", "status", "rating",
  "started", "finished", "notes", "cover_override",
  "year_pub", "genre", "carousel"
];
const COL = {};
COLUMNS.forEach(function (name, i) { COL[name] = i; }); // 0-based index map

const ENRICH_TRIED_HEADER = "enrich_tried"; // Phase 1 marker column (col 14)
const ENRICH_BATCH = 15;                     // rows processed per run

// Layer 2 tuning
const MAX_ATTEMPTS = 3;            // cover/meta retries before "exhausted"
const MIN_COVER_BYTES = 1500;     // 200-with-tiny-placeholder guard
const ENRICH_SLEEP_MS = 250;      // politeness delay between rows
const ENRICH_MAX_RUNTIME_MS = 280000; // ~4.7 min; under the 6-min GAS ceiling

// ============================================================
// PHASE 0 — WRITE ENDPOINT
// ============================================================

/* All writes arrive here. Body is raw JSON (text/plain, no CORS preflight).
   Shape:
     add    : { secret, action:"add",    book:{...} }      (action optional)
     update : { secret, action:"update", id:"b007", fields:{...} }
     delete : { secret, action:"delete", id:"b007" }
*/
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return json({ ok: false, error: "Unauthorized" });
    }

    const sheet = getSheet();
    if (!sheet) {
      return json({ ok: false, error: "Sheet tab '" + SHEET_NAME + "' not found" });
    }

    const action = (body.action || "add").toLowerCase();

    switch (action) {
      case "add":
      case "append":
        return appendBook(sheet, body.book || {});
      case "addbulk":
        return appendBooks(sheet, body.books || []);
      case "update":
        return updateRow(sheet, body.id, body.fields || {});
      case "delete":
        return deleteRow(sheet, body.id);
      default:
        return json({ ok: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* Health check. Visit the /exec URL in a browser to confirm it's live. */
function doGet() {
  return json({ ok: true, message: "Book tracker write endpoint is live." });
}

// ---- operations -------------------------------------------------

/* Append a new book with a freshly generated, server-side id. */
function appendBook(sheet, book) {
  if (!book.title || !String(book.title).trim()) {
    return json({ ok: false, error: "Title is required" });
  }
  const id = nextId(sheet);

  // Build the 13-col row in canonical order. id is server-generated; any
  // client-supplied id is ignored. Missing fields become "".
  const row = COLUMNS.map(function (col) {
    if (col === "id") return id;
    return book[col] != null ? String(book[col]) : "";
  });

  sheet.appendRow(row);
  return json({ ok: true, id: id });
}

/* Bulk append. Accepts an array of book objects, generates sequential ids,
   and writes all rows in ONE setValues call. Invalid (title-less) entries
   are skipped. id is always server-generated; client ids are ignored. */
function appendBooks(sheet, books) {
  if (!Array.isArray(books) || !books.length) {
    return json({ ok: false, error: "No books provided" });
  }
  const valid = books.filter(function (b) {
    return b && b.title && String(b.title).trim();
  });
  if (!valid.length) {
    return json({ ok: false, error: "No valid books (title required)" });
  }

  const start = maxIdNumber(sheet) + 1; // first new numeric id
  const rows = valid.map(function (b, i) {
    const id = "b" + String(start + i).padStart(3, "0");
    return COLUMNS.map(function (col) {
      if (col === "id") return id;
      return b[col] != null ? String(b[col]) : "";
    });
  });

  const firstRow = sheet.getLastRow() + 1;
  sheet.getRange(firstRow, 1, rows.length, COLUMNS.length).setValues(rows);

  return json({
    ok: true,
    added: rows.length,
    skipped: books.length - valid.length,
    firstId: rows[0][0],
    lastId: rows[rows.length - 1][0]
  });
}

/* Update an existing row, located BY ID. Only the supplied fields are
   written; `id` can never be changed; unknown keys are ignored. */
function updateRow(sheet, id, fields) {
  if (!id) return json({ ok: false, error: "Missing id" });

  const rowNum = findRowById(sheet, id);
  if (rowNum === -1) return json({ ok: false, error: "id not found: " + id });

  let wrote = 0;
  Object.keys(fields).forEach(function (key) {
    if (key === "id") return;            // id is immutable
    if (!(key in COL)) return;           // ignore unknown columns
    const colNum = COL[key] + 1;         // 1-based for getRange
    const val = fields[key] != null ? String(fields[key]) : "";
    sheet.getRange(rowNum, colNum).setValue(val);
    wrote++;
  });

  return json({ ok: true, id: id, updated: wrote });
}

/* Delete a row, located BY ID. */
function deleteRow(sheet, id) {
  if (!id) return json({ ok: false, error: "Missing id" });

  const rowNum = findRowById(sheet, id);
  if (rowNum === -1) return json({ ok: false, error: "id not found: " + id });

  sheet.deleteRow(rowNum);
  return json({ ok: true, id: id, deleted: true });
}

// ---- id + row helpers -------------------------------------------

/* Highest existing b-number across the id column (-1 if none). */
function maxIdNumber(sheet) {
  const ids = readIdColumn(sheet);
  let max = -1;
  ids.forEach(function (entry) {
    const m = /^b(\d+)$/.exec(entry.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max;
}

/* Next id: max b-number + 1, zero-padded to 3. Empty sheet -> b000. */
function nextId(sheet) {
  return "b" + String(maxIdNumber(sheet) + 1).padStart(3, "0");
}

/* Return the 1-based sheet row number for a given id, or -1. */
function findRowById(sheet, id) {
  const ids = readIdColumn(sheet);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].id === String(id)) return ids[i].rowNum;
  }
  return -1;
}

/* Read the id column (col A) for all data rows (row 2..last).
   Returns [{ id, rowNum }]. rowNum is the 1-based sheet row. */
function readIdColumn(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const idColIndex = COL["id"] + 1; // 1-based
  const values = sheet.getRange(2, idColIndex, last - 1, 1).getValues();
  return values.map(function (r, i) {
    return { id: String(r[0]).trim(), rowNum: i + 2 };
  });
}

function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// PHASE 1 + LAYER 2 — ENRICHMENT PIPELINE
// ============================================================
/*
   enrichBatch() is the time-driven target. Each run, for up to ENRICH_BATCH
   rows that still need work (rowNeedsWork_):
     1. META (blank-only): if isbn is blank, query Google Books then Open
        Library by title+author; write isbn (preferred) and year_pub only
        where currently blank.
     2. COVER (verified): check whether Open Library actually serves a cover
        for the ISBN the CLIENT will request (-M, both ISBN forms). If yes,
        leave cover_override blank — the client's OL-by-ISBN candidate loads
        it. If OL is DEFINITIVELY empty (404 / tiny placeholder), verify the
        Google/OL fallback cover URL and write it into cover_override. If OL
        was merely inconclusive (429 / 5xx), write nothing and retry later.
     3. STATE: enrich_tried holds "" | "<n>" | "ok" | "exhausted". Legacy
        ISO-timestamp / TRUE values are read as one prior attempt and RE-
        CHECKED, which unsticks rows the old write-once flag had stranded.

   SETUP / TEST / ARM:
     - One-time manual test:  editor -> select `enrichBatch` -> Run ->
       authorize (UrlFetch + Sheets) -> watch the Execution log.
     - Arm the hourly timer:  select `installEnrichTrigger` -> Run once.
     - Disarm:                select `removeEnrichTriggers` -> Run once.
     - Revive give-ups:       select `resetExhausted` -> Run once.
*/

function enrichBatch() {
  const startMs = Date.now();
  const sheet = getSheet();
  if (!sheet) { Logger.log("Sheet not found: " + SHEET_NAME); return; }

  const triedCol = ensureEnrichTriedColumn(sheet); // 1-based col index

  const last = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (last < 2) { Logger.log("No data rows."); return; }

  // Read the whole data block once.
  const data = sheet.getRange(2, 1, last - 1, lastCol).getValues();

  const idIdx = COL["id"];
  const titleIdx = COL["title"];
  const authorIdx = COL["author"];
  const isbnIdx = COL["isbn"];
  const coverIdx = COL["cover_override"];
  const yearIdx = COL["year_pub"];
  const triedIdx = triedCol - 1; // 0-based into the row array

  let processed = 0, resolved = 0;

  for (let i = 0; i < data.length; i++) {
    if (processed >= ENRICH_BATCH) break;
    if (Date.now() - startMs > ENRICH_MAX_RUNTIME_MS) { Logger.log("Time budget hit; stopping early."); break; }

    const row = data[i];
    const id = String(row[idIdx]).trim();
    const isbn = String(row[isbnIdx]).trim();
    const coverOverride = String(row[coverIdx]).trim();
    const tried = String(row[triedIdx] || "").trim();
    const yearCell = String(row[yearIdx]).trim();
    const title = String(row[titleIdx]).trim();
    const author = String(row[authorIdx]).trim();

    const stateRow = { isbn: isbn, cover_override: coverOverride, enrich_tried: tried };
    if (!rowNeedsWork_(stateRow)) continue;
    if (!title) continue;

    processed++;
    const sheetRow = i + 2; // stable: no inserts/deletes happen in this loop

    const needMeta = (isbn === "");
    const needCover = !coverResolved_(stateRow);

    let found = null;
    if (needMeta || needCover) {
      try {
        found = lookupGoogleBooks(title, author);
        if (!found || !found.isbn) {
          const ol = lookupOpenLibrary(title, author);
          found = mergeFindings(found, ol); // prefer Google, fall back to OL
        }
      } catch (err) {
        Logger.log("Lookup error for " + id + " (" + title + "): " + err);
        found = null;
      }
    }

    // --- metadata writes (blank-only) ---
    let effIsbn = isbn;
    if (needMeta && found && found.isbn) {
      sheet.getRange(sheetRow, isbnIdx + 1).setValue(found.isbn);
      effIsbn = found.isbn;
    }
    if (found && found.year && yearCell === "") {
      sheet.getRange(sheetRow, yearIdx + 1).setValue(found.year);
    }

    // --- cover verification ---
    let olState = "none";
    if (effIsbn) {
      const forms = isbnForms_(effIsbn);
      const states = [];
      for (let f = 0; f < forms.length; f++) states.push(olCoverStatus_(forms[f]));
      olState = combineOlStates_(states);
    }
    const fallbackUrl = cleanCoverUrl_(found ? found.cover : "");
    const fallbackOk = (olState === "none" && fallbackUrl) ? verifyImageUrl_(fallbackUrl) : false;
    const dec = decideCover_(coverOverride, olState, fallbackUrl, fallbackOk);
    if (dec.writeOverride && coverOverride === "") {
      sheet.getRange(sheetRow, coverIdx + 1).setValue(dec.writeOverride);
    }

    // --- stamp retry state ---
    sheet.getRange(sheetRow, triedCol).setValue(nextTried_(tried, dec.coverResolved));
    if (dec.coverResolved) resolved++;

    Utilities.sleep(ENRICH_SLEEP_MS);
  }

  Logger.log("enrichBatch: processed " + processed + ", coversResolved " + resolved);
}

/* Ensure the enrich_tried tracking column exists (appended after the
   canonical block). Returns its 1-based column index. */
function ensureEnrichTriedColumn(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === ENRICH_TRIED_HEADER) return i + 1;
  }
  const newCol = lastCol + 1;
  sheet.getRange(1, newCol).setValue(ENRICH_TRIED_HEADER);
  return newCol;
}

// ---- external lookups (unchanged from Phase 1) ------------------

/* Google Books — keyless. Targeted query (intitle + inauthor). Returns
   { isbn, year, cover } or null. */
function lookupGoogleBooks(title, author) {
  let q = 'intitle:"' + title + '"';
  if (author && author.toLowerCase() !== "unknown") {
    q += '+inauthor:"' + author + '"';
  }
  const url = "https://www.googleapis.com/books/v1/volumes?q=" +
    encodeURIComponent(q) + "&maxResults=5&country=US";

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;

  const data = JSON.parse(res.getContentText());
  const items = data.items || [];
  for (let i = 0; i < items.length; i++) {
    const v = items[i].volumeInfo || {};
    if (!titlesMatch(title, v.title || "")) continue;

    const ids = v.industryIdentifiers || [];
    let isbn = "";
    const i13 = ids.find(function (x) { return x.type === "ISBN_13"; });
    const i10 = ids.find(function (x) { return x.type === "ISBN_10"; });
    if (i13) isbn = i13.identifier;
    else if (i10) isbn = i10.identifier;

    const year = (v.publishedDate || "").slice(0, 4);
    let cover = "";
    if (v.imageLinks && v.imageLinks.thumbnail) {
      cover = v.imageLinks.thumbnail.replace(/^http:/, "https:");
    }
    return {
      isbn: cleanIsbn(isbn),
      year: /^\d{4}$/.test(year) ? year : "",
      cover: cover
    };
  }
  return null;
}

/* Open Library — keyless. Returns { isbn, year, cover } or null. */
function lookupOpenLibrary(title, author) {
  let url = "https://openlibrary.org/search.json?title=" +
    encodeURIComponent(title);
  if (author && author.toLowerCase() !== "unknown") {
    url += "&author=" + encodeURIComponent(author);
  }
  url += "&limit=5&fields=title,isbn,first_publish_year,cover_i";

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;

  const data = JSON.parse(res.getContentText());
  const docs = data.docs || [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!titlesMatch(title, d.title || "")) continue;

    const isbn = (d.isbn || [])[0] || "";
    const year = d.first_publish_year ? String(d.first_publish_year) : "";
    const cover = d.cover_i
      ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg"
      : "";
    return {
      isbn: cleanIsbn(isbn),
      year: /^\d{4}$/.test(year) ? year : "",
      cover: cover
    };
  }
  return null;
}

/* Prefer Google's findings; fill gaps from Open Library. */
function mergeFindings(g, o) {
  if (!g && !o) return null;
  g = g || {}; o = o || {};
  return {
    isbn: g.isbn || o.isbn || "",
    year: g.year || o.year || "",
    cover: g.cover || o.cover || ""
  };
}

// ---- match guards + cleaners (unchanged from Phase 1) -----------

/* Guard against writing a wildly-wrong ISBN: require meaningful title
   overlap (token Jaccard >= 0.5) or a containment relationship. */
function titlesMatch(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return true;

  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  const setB = {};
  tb.forEach(function (t) { setB[t] = true; });
  let inter = 0;
  ta.forEach(function (t) { if (setB[t]) inter++; });
  const union = (new Set(ta.concat(tb))).size;
  return union > 0 && (inter / union) >= 0.5;
}

function normTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")    // strip punctuation
    .replace(/\b(a|an|the)\b/g, " ") // drop articles
    .replace(/\s+/g, " ")
    .trim();
}

function cleanIsbn(s) {
  return String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();
}

// ============================================================
// LAYER 2 — verified-cover + retry-state helpers
// ============================================================

// ---- ISBN normalization + 10<->13 conversion (for OL both-form check) ----
function normalizeIsbn_(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().toUpperCase();
  if (/E\+?\d+$/.test(s) && s.indexOf(".") >= 0) {   // float-coercion artifact
    const n = Number(s);
    if (isFinite(n)) s = n.toFixed(0);
  }
  return s.replace(/[^0-9X]/g, "");
}
function isbn13Check_(f) { let s = 0; for (let i = 0; i < 12; i++) s += (i % 2 ? 3 : 1) * Number(f[i]); return (10 - (s % 10)) % 10; }
function isbn10Check_(f) { let s = 0; for (let i = 0; i < 9; i++) s += (10 - i) * Number(f[i]); const c = (11 - (s % 11)) % 11; return c === 10 ? "X" : String(c); }
function isbn10to13_(x) { if (x.length !== 10) return ""; const c = "978" + x.slice(0, 9); return c + String(isbn13Check_(c)); }
function isbn13to10_(x) { if (x.length !== 13 || x.slice(0, 3) !== "978") return ""; const c = x.slice(3, 12); return c + isbn10Check_(c); }
function isbnForms_(raw) {
  const s = normalizeIsbn_(raw);
  if (s.length !== 10 && s.length !== 13) return s ? [s] : [];
  const f = [s];
  if (s.length === 10) { const t = isbn10to13_(s); if (t && f.indexOf(t) < 0) f.push(t); }
  if (s.length === 13) { const t = isbn13to10_(s); if (t && f.indexOf(t) < 0) f.push(t); }
  return f;
}

// ---- enrich_tried state machine ----
function blank_(v) { return String(v == null ? "" : v).trim() === ""; }
function enrichState_(cell) {
  const v = String(cell == null ? "" : cell).trim().toLowerCase();
  if (v === "") return { done: false, exhausted: false, attempts: 0 };
  if (v === "ok") return { done: true, exhausted: false, attempts: 0 };
  if (v === "exhausted") return { done: false, exhausted: true, attempts: MAX_ATTEMPTS };
  const n = parseInt(v, 10);
  if (!isNaN(n) && String(n) === v) return { done: false, exhausted: false, attempts: n };
  // legacy truthy / ISO-timestamp (old write-once pipeline): one prior
  // attempt, NOT done -> Layer 2 re-checks the cover and unsticks it.
  return { done: false, exhausted: false, attempts: 1 };
}
function coverResolved_(row) {
  if (!blank_(row.cover_override)) return true;   // manual or prior fallback present
  return enrichState_(row.enrich_tried).done;      // "ok" = OL-verified good
}
function rowNeedsWork_(row) {
  const st = enrichState_(row.enrich_tried);
  if (st.done || st.exhausted) return false;
  if (st.attempts >= MAX_ATTEMPTS) return false;
  return blank_(row.isbn) || !coverResolved_(row);
}
function nextTried_(prevCell, coverResolvedNow) {
  if (coverResolvedNow) return "ok";
  const attempts = enrichState_(prevCell).attempts + 1;
  return attempts >= MAX_ATTEMPTS ? "exhausted" : String(attempts);
}

// ---- cover decision (pure, given verified network results) ----
function combineOlStates_(states) {
  if (states.indexOf("have") >= 0) return "have";
  if (states.indexOf("error") >= 0) return "error";
  return "none";
}
function decideCover_(existingOverride, olState, fallbackUrl, fallbackOk) {
  if (!blank_(existingOverride)) return { writeOverride: null, coverResolved: true }; // never clobber a set override
  if (olState === "have") return { writeOverride: null, coverResolved: true };         // client OL-by-ISBN will load it
  if (olState === "error") return { writeOverride: null, coverResolved: false };        // inconclusive: retry, no fallback
  if (fallbackUrl && fallbackOk) return { writeOverride: fallbackUrl, coverResolved: true };
  return { writeOverride: null, coverResolved: false };
}
function cleanCoverUrl_(url) {
  if (!url) return "";
  return String(url).replace(/^http:\/\//i, "https://").replace(/&edge=curl/gi, "");
}

// ---- cover verification (network) ----
function urlStatus_(url) {
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  let bytes = 0;
  try { bytes = resp.getBlob().getBytes().length; } catch (e) { bytes = 0; }
  return { code: resp.getResponseCode(), bytes: bytes };
}
// "have" | "none" | "error" — error reserved for inconclusive (429/5xx/network).
function olCoverStatus_(isbn) {
  if (!isbn) return "none";
  const r = urlStatus_("https://covers.openlibrary.org/b/isbn/" + isbn + "-M.jpg?default=false");
  if (r.code === 200 && r.bytes >= MIN_COVER_BYTES) return "have";
  if (r.code === 404) return "none";
  if (r.code === 200) return "none";   // 200 but tiny -> placeholder, treat as none
  return "error";                       // 429/5xx/etc
}
function verifyImageUrl_(url) {
  if (!url) return false;
  const r = urlStatus_(url);
  return r.code === 200 && r.bytes >= MIN_COVER_BYTES;
}

// ---- trigger management (unchanged from Phase 1) ----------------

/* Run ONCE to arm the hourly timer. Idempotent: clears any existing
   enrichBatch triggers first so you never stack duplicates. */
function installEnrichTrigger() {
  removeEnrichTriggers();
  ScriptApp.newTrigger("enrichBatch")
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log("Hourly enrichBatch trigger installed.");
}

/* Run to disarm. */
function removeEnrichTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === "enrichBatch") {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log("Removed " + removed + " enrichBatch trigger(s).");
}

/* Run ONCE to revive rows that hit "exhausted" (e.g. after a long OL
   outage). Clears their enrich_tried so the next batch retries them. */
function resetExhausted() {
  const sheet = getSheet();
  if (!sheet) return;
  const triedCol = ensureEnrichTriedColumn(sheet);
  const last = sheet.getLastRow();
  if (last < 2) return;
  const vals = sheet.getRange(2, triedCol, last - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === "exhausted") {
      sheet.getRange(i + 2, triedCol).setValue(""); n++;
    }
  }
  Logger.log("reset " + n + " exhausted row(s).");
}

/*
   RATE / QUOTA NOTES (Layer 2)
   ----------------------------
   Batch = 15 rows/run, hourly. Per qualifying row, worst case:
     1 Google Books + 1 Open Library (meta) + 2 OL cover GETs (both ISBN
     forms) + 1 fallback verify  ≈ 5 fetches/row -> ~75/run -> ~1,800/day
   if the timer never idles. UrlFetchApp quota is 20,000/day -> ~9%.
   Covers converge then the batch goes quiet: once a row is "ok"/"exhausted"
   it no longer qualifies. If OL throttles (HTTP 429) you'll see covers stay
   unresolved and attempts climb; that's the "error" path holding off on a
   wrong Google fallback — widen cadence or lower ENRICH_BATCH if persistent.
   (confidence: keyless Books/OL limits are not formally published — moderate.)
*/
