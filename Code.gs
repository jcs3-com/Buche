/* Apps Script backend for the jcs3 book tracker  — V2
   =====================================================
   Bound to the Google Sheet (Extensions -> Apps Script). NOT on the site.

   PHASE 0  — write endpoint:  doPost routes add | update | delete, all keyed
              by the stable `id` (b000, b001, …), never by row position.
   PHASE 1  — enrichment:      enrichBatch() backfills isbn / cover_override /
              year_pub from Google Books + Open Library, BY ID, blanks only.

   DEPLOY (write endpoint):
     Save -> Deploy -> New deployment -> Web app ->
     Execute as: Me / Who has access: Anyone -> Deploy -> authorize ->
     copy the /exec URL into books.js (WRITE_URL).
   REDEPLOY after editing this file:
     Deploy -> Manage deployments -> edit (pencil) -> Version: New version ->
     Deploy. The /exec URL stays the same.

   SHARED_SECRET below MUST match SHARED_SECRET in books.js exactly.
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
// PHASE 1 — ENRICHMENT PIPELINE
// ============================================================
/*
   enrichBatch() is the time-driven target. Each run:
     1. Picks up to ENRICH_BATCH (15) rows where isbn is blank AND the row
        has never been tried (enrich_tried blank).
     2. For each: queries Google Books, then Open Library, by title+author.
     3. Writes back BY ID, blanks only: isbn (preferred), year_pub, and
        cover_override ONLY when there is a direct cover URL but no isbn
        (when isbn is found, the site derives the cover from it).
     4. Stamps enrich_tried with an ISO timestamp on EVERY attempt — so a
        no-match row is never retried forever, and the batch is idempotent.

   SETUP / TEST / ARM:
     - One-time manual test:  Apps Script editor -> select `enrichBatch` ->
       Run -> authorize (UrlFetch + Sheets) -> watch the Execution log.
     - Arm the hourly timer:  select `installEnrichTrigger` -> Run once.
     - Disarm:                select `removeEnrichTriggers` -> Run once.

   RATE / QUOTA MATH (see notes at bottom of this section):
     40 books, all isbn-blank -> 3 hourly runs clear them (15 + 15 + 10).
     Per run: <= 15 * 2 = 30 external fetches (Google Books, then Open
     Library only on miss). Hourly cap -> <= 720 fetches/day. Well under
     UrlFetchApp's 20,000/day quota and typical keyless API tolerances.
*/

function enrichBatch() {
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

  let processed = 0, matched = 0;

  for (let i = 0; i < data.length && processed < ENRICH_BATCH; i++) {
    const row = data[i];
    const id = String(row[idIdx]).trim();
    const isbn = String(row[isbnIdx]).trim();
    const tried = String(row[triedIdx] || "").trim();

    // Candidate predicate: missing ISBN AND never tried.
    if (isbn !== "" || tried !== "") continue;

    const title = String(row[titleIdx]).trim();
    const author = String(row[authorIdx]).trim();
    if (!title) continue;

    processed++;
    const sheetRow = i + 2; // stable: no inserts/deletes happen in this loop
    const stamp = new Date().toISOString();

    let found = null;
    try {
      found = lookupGoogleBooks(title, author);
      if (!found || !found.isbn) {
        const ol = lookupOpenLibrary(title, author);
        // Merge: prefer Google for any field it filled, fall back to OL.
        found = mergeFindings(found, ol);
      }
    } catch (err) {
      Logger.log("Lookup error for " + id + " (" + title + "): " + err);
      found = null;
    }

    // Always stamp the attempt so we never retry this row blindly.
    sheet.getRange(sheetRow, triedCol).setValue(stamp);

    if (found) {
      // isbn — only if we have one and the cell is blank (it is, by predicate).
      if (found.isbn) {
        sheet.getRange(sheetRow, isbnIdx + 1).setValue(found.isbn);
      }
      // year_pub — only if found and currently blank.
      if (found.year && String(row[yearIdx]).trim() === "") {
        sheet.getRange(sheetRow, yearIdx + 1).setValue(found.year);
      }
      // cover_override — ONLY when no isbn (so the isbn cover path won't
      // resolve) but we do have a direct cover URL, and the cell is blank.
      if (!found.isbn && found.cover && String(row[coverIdx]).trim() === "") {
        sheet.getRange(sheetRow, coverIdx + 1).setValue(found.cover);
      }
      if (found.isbn || found.cover || found.year) matched++;
    }
  }

  Logger.log("enrichBatch: processed " + processed + ", matched " + matched);
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

// ---- external lookups -------------------------------------------

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

// ---- match guards + cleaners ------------------------------------

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

// ---- trigger management -----------------------------------------

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

/*
   RATE / QUOTA NOTES
   ------------------
   Batch = 15 rows/run, hourly.
   - Current data: 40 rows, all isbn-blank -> 15 + 15 + 10 = 3 runs to clear
     (~3 hours). After that, each run finds 0 candidates and does no fetches.
   - Per-run external calls: 1 Google Books call per row always; 1 Open
     Library call only when Google misses an ISBN. Worst case 2/row = 30/run.
   - Daily worst case (timer never idle): 30 * 24 = 720 fetches/day.
     UrlFetchApp quota for consumer Google accounts is 20,000/day -> ~3.6%.
   - Google Books keyless: tolerant for low volume; if you ever see HTTP 429,
     drop ENRICH_BATCH or widen cadence to every 2-3 hours. (confidence:
     moderate — keyless Books limits are not formally published.)
   - Open Library: no key, no hard published cap; 1 call/row on misses only.
   New form-adds (one isbn-blank row at a time) are absorbed by the next
   hourly run with negligible additional load.
*/
