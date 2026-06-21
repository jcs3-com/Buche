/* Books page — jcs3.com
   ----------------------
   READ:   Google Sheet published as CSV (public, no auth)
   SEARCH: Open Library + Google Books (public, no auth, no key)
   WRITE:  Apps Script Web App endpoint (POST, shared-secret guarded)

   ============================================================
   TWO THINGS TO SET BELOW after deploying Code.gs:
     1. WRITE_URL   = your Apps Script /exec URL
     2. SHARED_SECRET = the SAME random string you put in Code.gs
   ============================================================
*/

const SHEET_ID = "1KKIvqsmxjh0s8uXwYYEeD6C_5sq7xRdEpc0FofPPHTM";
const SHEET_NAME = "Sheet1";
const LIBBY_LIBRARY = "dclibrary"; // DCPL Libby key; confirm once via libbyapp.com URL

const WRITE_URL = "https://script.google.com/macros/s/AKfycbzHLjRPwP1HCFotfPdHf843pSsNHZ55bQbT_KDu8Z5vUu1R_pCIRB9DSE7DEbGOCPWx7A/exec";
const SHARED_SECRET = "shar3dsecret123";

const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

// ---- State ----
let allBooks = [];
let currentFilter = "all";
let currentSort = "date-desc";
let currentSearch = "";
let searchTimer = null;
let selectedCandidate = null; // book chosen from search, before manual edits
let editingId = null;         // non-null when the form is editing an existing book
let editBaseline = null;      // canonical form values of the book being edited (for diffing)
let importCandidates = [];    // parsed + classified rows awaiting bulk import

// ---- Boot ----
document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await refresh();
}

async function refresh() {
  try {
    allBooks = await loadBooks();
    renderStats(allBooks);
    renderCarousels(allBooks); // themed shelves — independent of tabs/search/sort
    if (!allBooks.length) {
      showEmpty("No books yet. Use “Add a book” above to get started.");
      return;
    }
    render();
  } catch (err) {
    console.error("Book tracker error:", err);
    showError(`Couldn't load books. Open the browser console for details. (${err.message})`);
  }
}

function bindEvents() {
  document.getElementById("bt-tabs").addEventListener("click", e => {
    if (e.target.tagName !== "BUTTON") return;
    document.querySelectorAll(".bt-tab").forEach(t => t.classList.remove("active"));
    e.target.classList.add("active");
    currentFilter = e.target.dataset.f;
    render();
  });

  document.getElementById("bt-search").addEventListener("input", e => {
    currentSearch = e.target.value.trim().toLowerCase();
    render();
  });

  document.getElementById("bt-sort").addEventListener("change", e => {
    currentSort = e.target.value;
    render();
  });

  // Add-book panel
  document.getElementById("bt-add-toggle").addEventListener("click", toggleAddPanel);
  document.getElementById("bt-book-search").addEventListener("input", onBookSearchInput);
  document.getElementById("bt-cancel").addEventListener("click", resetAddPanel);
  document.getElementById("bt-entry-form").addEventListener("submit", onSaveBook);

  // Edit / delete on grid cards (event delegation survives re-renders)
  document.getElementById("bt-grid").addEventListener("click", e => {
    const editBtn = e.target.closest(".bt-edit");
    if (editBtn) { onEditClick(editBtn.dataset.id); return; }
    const delBtn = e.target.closest(".bt-delete");
    if (delBtn) { onDeleteClick(delBtn.dataset.id); return; }
  });

  // Bulk import
  document.getElementById("bt-import-toggle").addEventListener("click", toggleImportPanel);
  document.getElementById("bt-import-preview").addEventListener("click", onImportPreview);
  document.getElementById("bt-import-cancel").addEventListener("click", resetImportPanel);
  document.getElementById("bt-import-file").addEventListener("change", onImportFile);
  document.getElementById("bt-import-result").addEventListener("click", onImportResultClick);

  // Close search dropdown when clicking outside
  document.addEventListener("click", e => {
    if (!e.target.closest(".bt-search-wrap")) hideResults();
  });
}

// ============================================================
// READ
// ============================================================
async function loadBooks() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (!rows.length) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (row[i] || "").trim(); });
      return obj;
    })
    .filter(b => b.title)
    .map(normalize);
}

/* Forgiving normalizer: accepts loose status words and date formats.
   Carries the full V2 schema through: id (load-bearing key for write-back,
   edit, delete), plus the descriptive fields year_pub / genre / carousel.
   `carousel` is a comma-separated multi-tag -> parsed to an array. */
function normalize(b) {
  return {
    id: (b.id || "").trim(),
    title: b.title,
    author: b.author || "Unknown",
    isbn: (b.isbn || "").replace(/[^0-9X]/gi, ""),
    status: normalizeStatus(b.status),
    rating: normalizeRating(b.rating),
    started: normalizeDate(b.started),
    finished: normalizeDate(b.finished),
    notes: b.notes || "",
    coverOverride: b.cover_override || "",
    yearPub: (b.year_pub || "").toString().trim(),
    genre: (b.genre || "").trim(),
    carousels: parseCarousels(b.carousel)
  };
}

/* "Wanderlust #1, Frank Ocean Lost" -> ["Wanderlust #1", "Frank Ocean Lost"].
   Orthogonal to status; a book may belong to multiple carousels. */
function parseCarousels(s) {
  return (s || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
}

/* Stable runtime match key for dedup / enrichment row-matching (V2 spec). */
function bookKey(title, author) {
  return (String(title || "") + "|" + String(author || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(s) {
  const v = (s || "").trim().toLowerCase();
  if (["reading", "currently reading", "in progress", "started"].includes(v)) return "reading";
  if (["read", "finished", "done", "complete", "completed"].includes(v)) return "read";
  if (["dnf", "did not finish", "abandoned", "gave up"].includes(v)) return "dnf";
  if (["tbr", "to read", "to-read", "want to read", "wishlist", ""].includes(v)) return "tbr";
  return "tbr";
}

function normalizeRating(r) {
  const n = parseInt(r, 10);
  return n >= 1 && n <= 5 ? n : null;
}

/* Accepts YYYY-MM-DD, M/YYYY, MM/DD/YYYY, YYYY. Returns YYYY-MM-DD-ish
   sortable string. Best-effort; blanks stay blank. */
function normalizeDate(d) {
  const v = (d || "").trim();
  if (!v) return "";
  // Already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{4}-\d{1,2}$/.test(v)) { // YYYY-M
    const [y, m] = v.split("-");
    return `${y}-${m.padStart(2, "0")}-01`;
  }
  if (/^\d{4}$/.test(v)) return `${v}-01-01`;
  // M/YYYY  or  MM/YYYY
  let m = v.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}-01`;
  // M/D/YYYY
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  // Fallback: let Date try
  const parsed = new Date(v);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return v; // give up, keep raw
}

function parseCSV(text, delim) {
  delim = delim || ",";
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else { field += c; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c && c.trim() !== ""));
}

// ============================================================
// LIVE SEARCH (Open Library + Google Books)
// ============================================================
function onBookSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 3) { hideResults(); return; }
  searchTimer = setTimeout(() => runBookSearch(q), 300);
}

async function runBookSearch(q) {
  const box = document.getElementById("bt-search-results");
  box.hidden = false;
  box.innerHTML = `<div class="bt-result-msg">Searching…</div>`;

  let candidates = [];
  try {
    const [google, openlib] = await Promise.allSettled([
      searchGoogleBooks(q),
      searchOpenLibrary(q)
    ]);
    if (google.status === "fulfilled") candidates = candidates.concat(google.value);
    if (openlib.status === "fulfilled") candidates = candidates.concat(openlib.value);
  } catch (err) {
    console.error("Search error:", err);
  }

  candidates = dedupe(candidates).slice(0, 6);
  renderResults(candidates, q);
}

async function searchGoogleBooks(q) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Google Books " + res.status);
  const data = await res.json();
  return (data.items || []).map(item => {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbn13 = ids.find(x => x.type === "ISBN_13");
    const isbn10 = ids.find(x => x.type === "ISBN_10");
    return {
      title: v.title || "",
      author: (v.authors || []).join(", ") || "Unknown",
      isbn: (isbn13 || isbn10 || {}).identifier || "",
      year: (v.publishedDate || "").slice(0, 4),
      cover: v.imageLinks ? v.imageLinks.thumbnail.replace(/^http:/, "https:") : "",
      source: "google"
    };
  }).filter(b => b.title);
}

async function searchOpenLibrary(q) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=5&fields=title,author_name,isbn,first_publish_year,cover_i`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Open Library " + res.status);
  const data = await res.json();
  return (data.docs || []).map(d => ({
    title: d.title || "",
    author: (d.author_name || []).join(", ") || "Unknown",
    isbn: (d.isbn || [])[0] || "",
    year: d.first_publish_year ? String(d.first_publish_year) : "",
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg` : "",
    source: "openlibrary"
  })).filter(b => b.title);
}

/* De-dupe by normalized title+author, preferring the entry that has an ISBN. */
function dedupe(list) {
  const map = new Map();
  for (const b of list) {
    const key = (b.title + "|" + b.author).toLowerCase().replace(/\s+/g, " ").trim();
    const existing = map.get(key);
    if (!existing) { map.set(key, b); }
    else if (!existing.isbn && b.isbn) { map.set(key, b); }
  }
  return Array.from(map.values());
}

function renderResults(candidates, q) {
  const box = document.getElementById("bt-search-results");
  let html = candidates.map((b, i) => `
    <button type="button" class="bt-result" data-idx="${i}">
      <span class="bt-result-cover">${b.cover ? `<img src="${escapeAttr(b.cover)}" alt="" loading="lazy"/>` : ""}</span>
      <span class="bt-result-text">
        <span class="bt-result-title">${escapeHTML(b.title)}</span>
        <span class="bt-result-author">${escapeHTML(b.author)}${b.year ? " · " + b.year : ""}</span>
      </span>
    </button>
  `).join("");

  html += `<button type="button" class="bt-result bt-result-manual" data-idx="manual">
      + Add “${escapeHTML(q)}” manually
    </button>`;

  box.innerHTML = html;
  box.hidden = false;

  box.querySelectorAll(".bt-result").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.idx;
      if (idx === "manual") {
        openForm({ title: q });
      } else {
        openForm(candidates[parseInt(idx, 10)]);
      }
      hideResults();
    });
  });
}

function hideResults() {
  const box = document.getElementById("bt-search-results");
  box.hidden = true;
  box.innerHTML = "";
}

// ============================================================
// ENTRY FORM  (shared by Add and Edit)
// ============================================================
function toggleAddPanel() {
  const panel = document.getElementById("bt-add-panel");
  document.getElementById("bt-import-panel").hidden = true; // one panel at a time
  const wasHidden = panel.hidden;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    // opening fresh via the toggle => ADD mode
    setAddMode();
    document.getElementById("bt-book-search").focus();
  } else {
    resetAddPanel();
  }
}

/* Setup-incomplete guard, shared by add/edit/delete. */
function setupIncomplete() {
  return WRITE_URL.startsWith("PASTE_") || SHARED_SECRET.startsWith("CHANGE_ME");
}

/* Single POST path for every write. text/plain avoids a CORS preflight that
   Apps Script can't answer. Throws on {ok:false}. */
async function postWrite(payload) {
  const res = await fetch(WRITE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Unknown error");
  return data;
}

/* Read the form into the canonical 12-field editable shape (id excluded).
   Uses form.elements[...] because form.<name> is unsafe for names that
   collide with HTMLElement properties (notably `title`). */
function readFormValues(form) {
  const f = form.elements;
  return {
    title: f.title.value.trim(),
    author: f.author.value.trim(),
    isbn: f.isbn.value.replace(/[^0-9Xx]/g, ""),
    status: f.status.value,
    rating: f.rating.value,
    started: f.started.value,
    finished: f.finished.value,
    notes: f.notes.value.trim(),
    cover_override: f.cover_override.value.trim(),
    year_pub: f.year_pub.value.trim(),
    genre: f.genre.value.trim(),
    carousel: f.carousel.value.trim()
  };
}

/* Project a normalized book into that same shape — used to populate the edit
   form AND as the diff baseline so unchanged fields are never rewritten. */
function bookToFormValues(b) {
  return {
    title: b.title || "",
    author: (b.author && b.author !== "Unknown") ? b.author : "",
    isbn: b.isbn || "",
    status: b.status || "tbr",
    rating: b.rating ? String(b.rating) : "",
    started: b.started || "",
    finished: b.finished || "",
    notes: b.notes || "",
    cover_override: b.coverOverride || "",
    year_pub: b.yearPub || "",
    genre: b.genre || "",
    carousel: (b.carousels || []).join(", ")
  };
}

function fillForm(values) {
  const form = document.getElementById("bt-entry-form");
  Object.keys(values).forEach(k => {
    const el = form.elements[k];
    if (el != null) el.value = values[k];
  });
}

function setFormCover(url) {
  const coverBox = document.getElementById("bt-form-cover-box");
  if (url) {
    coverBox.innerHTML = `<img src="${escapeAttr(url)}" alt="cover"
      onerror="this.parentNode.innerHTML='<span>No cover</span>'" />`;
  } else {
    coverBox.innerHTML = `<span>No cover</span>`;
  }
}

/* Configure the panel chrome for ADD vs EDIT. */
function setAddMode() {
  editingId = null;
  editBaseline = null;
  document.getElementById("bt-search-wrap").hidden = false;
  document.getElementById("bt-form-mode").hidden = true;
  document.getElementById("bt-save").textContent = "Save book";
}
function setEditMode(book) {
  editingId = book.id;
  document.getElementById("bt-search-wrap").hidden = true;
  const banner = document.getElementById("bt-form-mode");
  banner.textContent = "Editing: " + book.title;
  banner.hidden = false;
  document.getElementById("bt-save").textContent = "Update book";
}

/* ADD: open the form pre-filled from a search candidate (or {title} for manual). */
function openForm(candidate) {
  selectedCandidate = candidate;
  setAddMode();
  const form = document.getElementById("bt-entry-form");
  form.hidden = false;
  fillForm(Object.assign(bookToFormValues({}), {
    title: candidate.title || "",
    author: (candidate.author && candidate.author !== "Unknown") ? candidate.author : "",
    isbn: candidate.isbn || ""
  }));
  const coverUrl = candidate.isbn
    ? `https://covers.openlibrary.org/b/isbn/${candidate.isbn}-M.jpg?default=false`
    : candidate.cover || "";
  setFormCover(coverUrl);
  form.elements.title.focus();
}

/* EDIT: open the form populated from an existing book. */
function onEditClick(id) {
  const book = allBooks.find(b => b.id === id);
  if (!book) { showToast("Could not find that book to edit.", true); return; }

  const panel = document.getElementById("bt-add-panel");
  panel.hidden = false;
  const form = document.getElementById("bt-entry-form");
  form.hidden = false;

  editBaseline = bookToFormValues(book);
  fillForm(editBaseline);
  setEditMode(book);
  setFormCover(coverSrcFor(book));
  document.getElementById("bt-form-msg").hidden = true;

  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus();
}

/* DELETE: confirm, then remove by id. */
async function onDeleteClick(id) {
  const book = allBooks.find(b => b.id === id);
  if (!book) { showToast("Could not find that book to delete.", true); return; }
  if (setupIncomplete()) {
    showToast("Setup incomplete: set WRITE_URL and SHARED_SECRET in books.js.", true);
    return;
  }
  if (!window.confirm(`Delete “${book.title}”? This permanently removes it from your Sheet.`)) return;

  try {
    showToast("Deleting…");
    await postWrite({ secret: SHARED_SECRET, action: "delete", id });
    showToast("Deleted.");
    await refresh();
  } catch (err) {
    console.error("Delete failed:", err);
    showToast("Delete failed: " + err.message, true);
  }
}

function resetAddPanel() {
  selectedCandidate = null;
  const form = document.getElementById("bt-entry-form");
  form.reset();
  form.hidden = true;
  document.getElementById("bt-book-search").value = "";
  document.getElementById("bt-form-msg").hidden = true;
  setAddMode();
  hideResults();
}

async function onSaveBook(e) {
  e.preventDefault();
  const form = e.target;
  const saveBtn = document.getElementById("bt-save");

  if (!form.elements.title.value.trim()) {
    showFormMsg("Title is required.", true);
    return;
  }
  if (setupIncomplete()) {
    showFormMsg("Setup incomplete: set WRITE_URL and SHARED_SECRET in books.js.", true);
    return;
  }

  const values = readFormValues(form);

  try {
    saveBtn.disabled = true;

    if (editingId) {
      // UPDATE: send only the fields that actually changed.
      const fields = {};
      Object.keys(values).forEach(k => {
        if (!editBaseline || values[k] !== editBaseline[k]) fields[k] = values[k];
      });
      if (!Object.keys(fields).length) {
        showFormMsg("No changes to save.", false);
        saveBtn.disabled = false;
        return;
      }
      showFormMsg("Updating…", false);
      await postWrite({ secret: SHARED_SECRET, action: "update", id: editingId, fields });
      showToast("Updated.");
    } else {
      // ADD: server generates the id.
      showFormMsg("Saving…", false);
      await postWrite({ secret: SHARED_SECRET, action: "add", book: values });
      showToast("Saved.");
    }

    await refresh();
    resetAddPanel();
    document.getElementById("bt-add-panel").hidden = true;
  } catch (err) {
    console.error("Save failed:", err);
    showFormMsg((editingId ? "Update" : "Save") + " failed: " + err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

function showFormMsg(text, isError) {
  const msg = document.getElementById("bt-form-msg");
  msg.textContent = text;
  msg.hidden = false;
  msg.className = "bt-form-msg" + (isError ? " bt-form-msg-error" : "");
}

/* Lightweight transient toast for write feedback. */
let toastTimer = null;
function showToast(text, isError) {
  let el = document.getElementById("bt-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "bt-toast";
    el.className = "bt-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = "bt-toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "bt-toast" + (isError ? " error" : ""); }, 2600);
}

// ============================================================
// BULK IMPORT  (Phase 4a/4b: CSV/TSV/Excel + Markdown lists)
// ------------------------------------------------------------
// Pure client-side parse -> classify (dedup on title+author) -> human review
// -> one atomic addBulk write. Excel is read via SheetJS, lazy-loaded from a
// CDN only when an .xlsx is chosen, so the base page stays dependency-free.
// ============================================================
const IMPORT_COLUMNS = [
  "title", "author", "isbn", "status", "rating", "started",
  "finished", "notes", "cover_override", "year_pub", "genre", "carousel"
];

function toggleImportPanel() {
  const panel = document.getElementById("bt-import-panel");
  document.getElementById("bt-add-panel").hidden = true; // one panel at a time
  panel.hidden = !panel.hidden;
  if (panel.hidden) resetImportPanel();
  else document.getElementById("bt-import-text").focus();
}

function resetImportPanel() {
  importCandidates = [];
  document.getElementById("bt-import-panel").hidden = true;
  document.getElementById("bt-import-text").value = "";
  document.getElementById("bt-import-file").value = "";
  document.getElementById("bt-import-filename").textContent = "";
  const result = document.getElementById("bt-import-result");
  result.hidden = true;
  result.innerHTML = "";
  hideImportMsg();
}

function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("bt-import-filename").textContent = file.name;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx") { readXlsx(file); return; }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("bt-import-text").value = reader.result; };
  reader.onerror = () => showImportMsg("Couldn't read that file.", true);
  reader.readAsText(file);
}

/* Excel: lazy-load SheetJS from CDN, convert first sheet to CSV into the textarea. */
async function readXlsx(file) {
  showImportMsg("Reading .xlsx…", false);
  try {
    await loadSheetJS();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    document.getElementById("bt-import-text").value = window.XLSX.utils.sheet_to_csv(ws);
    hideImportMsg();
  } catch (err) {
    showImportMsg("Couldn't read .xlsx (" + err.message + "). Export to CSV and paste instead.", true);
  }
}
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("CDN load failed"));
    document.head.appendChild(s);
  });
}

function onImportPreview() {
  const text = document.getElementById("bt-import-text").value;
  const raw = parseImport(text);
  if (!raw.length) {
    showImportMsg("Nothing parseable found. Check the format and try again.", true);
    return;
  }
  importCandidates = classifyImports(raw.map(importToBook).filter(b => b.title));
  hideImportMsg();
  renderImportPreview(importCandidates);
}

/* Dispatch by shape: Markdown pipe table -> delimited-with-header -> list. */
function parseImport(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines[0].startsWith("|")) return parsePipeTable(lines);

  const first = lines[0];
  const hasTab = first.indexOf("\t") >= 0;
  const hasComma = first.indexOf(",") >= 0;
  const headerHasTitle = /(^|[,\t])\s*title\s*([,\t]|$)/i.test(first);
  if ((hasTab || hasComma) && headerHasTitle) {
    const delim = hasTab && (!hasComma || first.split("\t").length > first.split(",").length) ? "\t" : ",";
    return parseTabular(text, delim);
  }
  return lines.map(parseListLine).filter(b => b.title);
}

function parseTabular(text, delim) {
  const rows = parseCSV(text, delim);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const known = new Set(IMPORT_COLUMNS);
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (known.has(h)) o[h] = (r[i] || "").trim(); });
    return o;
  }).filter(o => o.title);
}

function parsePipeTable(lines) {
  const rows = lines.map(l => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()));
  const data = rows.filter(r => !r.every(c => c === "" || /^:?-{3,}:?$/.test(c)));
  if (!data.length) return [];
  const headers = data[0].map(h => h.toLowerCase());
  const known = new Set(IMPORT_COLUMNS);
  const hasTitleHeader = headers.indexOf("title") >= 0;
  return data.slice(1).map(r => {
    const o = {};
    if (hasTitleHeader) {
      headers.forEach((h, i) => { if (known.has(h)) o[h] = (r[i] || "").trim(); });
    } else { // positional: col0 title, col1 author
      o.title = (r[0] || "").trim();
      if (r[1]) o.author = r[1].trim();
    }
    return o;
  }).filter(o => o.title);
}

/* One book per line. Tolerates bullets/numbers/checkboxes and several
   title/author separators ("by", em/en dash, " - ", tab, comma). */
function parseListLine(line) {
  let s = line
    .replace(/^\s*[-*+•]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim();
  let title = s, author = "", m;
  if ((m = s.match(/^(.*?)\s+by\s+(.+)$/i))) { title = m[1]; author = m[2]; }
  else if ((m = s.match(/^(.*?)\s*[—–]\s*(.+)$/))) { title = m[1]; author = m[2]; }
  else if ((m = s.match(/^(.*?)\s+-\s+(.+)$/))) { title = m[1]; author = m[2]; }
  else if (s.indexOf("\t") >= 0) { const p = s.split("\t"); title = p[0]; author = p.slice(1).join(" ").trim(); }
  else if (s.indexOf(",") >= 0) { const p = s.split(","); title = p[0]; author = p.slice(1).join(",").trim(); }
  return { title: stripQuotes(title), author: stripQuotes(author) };
}
function stripQuotes(s) {
  return String(s || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

/* Raw parsed row -> canonical 12-field book (defaults + status/date normalize). */
function importToBook(raw) {
  const r = normalizeRating(raw.rating);
  return {
    title: (raw.title || "").trim(),
    author: (raw.author || "").trim(),
    isbn: (raw.isbn || "").replace(/[^0-9Xx]/g, ""),
    status: raw.status ? normalizeStatus(raw.status) : "tbr",
    rating: r ? String(r) : "",
    started: normalizeDate(raw.started || ""),
    finished: normalizeDate(raw.finished || ""),
    notes: (raw.notes || "").trim(),
    cover_override: (raw.cover_override || "").trim(),
    year_pub: (raw.year_pub != null ? String(raw.year_pub) : "").trim(),
    genre: (raw.genre || "").trim(),
    carousel: (raw.carousel || "").trim()
  };
}

/* Flag duplicates against the existing library and within the batch. */
function classifyImports(books) {
  const existing = new Set(allBooks.map(b => bookKey(b.title, b.author)));
  const seen = new Set();
  return books.map(b => {
    const key = bookKey(b.title, b.author);
    let dup = "";
    if (existing.has(key)) dup = "library";
    else if (seen.has(key)) dup = "file";
    seen.add(key);
    return Object.assign({}, b, { _key: key, _dup: dup });
  });
}

function renderImportPreview(list) {
  const newCount = list.filter(b => !b._dup).length;
  const dupCount = list.length - newCount;
  const rows = list.map((b, i) => {
    const badge = b._dup === "library"
      ? `<span class="bt-dup-badge">in library</span>`
      : (b._dup === "file" ? `<span class="bt-dup-badge">dup in file</span>` : `<span class="bt-new-badge">new</span>`);
    return `<tr class="bt-import-row">
      <td><input type="checkbox" class="bt-import-cb" data-idx="${i}" ${b._dup ? "" : "checked"} /></td>
      <td>${escapeHTML(b.title)}</td>
      <td>${escapeHTML(b.author)}</td>
      <td>${escapeHTML(STATUS_LABELS[b.status] || b.status)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join("");

  document.getElementById("bt-import-result").innerHTML = `
    <p class="bt-import-summary">${newCount} new · ${dupCount} duplicate${dupCount === 1 ? "" : "s"} (duplicates unchecked by default)</p>
    <div class="bt-import-table-wrap">
      <table class="bt-import-table">
        <thead><tr>
          <th><input type="checkbox" id="bt-import-selall" aria-label="Select all" /></th>
          <th>Title</th><th>Author</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="bt-form-actions">
      <button type="button" id="bt-import-do" class="bt-btn-primary">Import selected</button>
    </div>`;
  document.getElementById("bt-import-result").hidden = false;
}

function onImportResultClick(e) {
  if (e.target.id === "bt-import-selall") {
    const on = e.target.checked;
    document.querySelectorAll(".bt-import-cb").forEach(cb => { cb.checked = on; });
    return;
  }
  if (e.target.id === "bt-import-do") { doImport(); }
}

async function doImport() {
  if (setupIncomplete()) {
    showImportMsg("Setup incomplete: set WRITE_URL and SHARED_SECRET in books.js.", true);
    return;
  }
  const checked = Array.from(document.querySelectorAll(".bt-import-cb"))
    .filter(cb => cb.checked)
    .map(cb => importCandidates[parseInt(cb.dataset.idx, 10)]);
  if (!checked.length) { showImportMsg("Nothing selected to import.", true); return; }

  const books = checked.map(b => {
    const copy = {};
    IMPORT_COLUMNS.forEach(k => { copy[k] = b[k] != null ? b[k] : ""; });
    return copy;
  });

  const doBtn = document.getElementById("bt-import-do");
  if (doBtn) doBtn.disabled = true;
  showImportMsg("Importing " + books.length + "…", false);
  try {
    const data = await postWrite({ secret: SHARED_SECRET, action: "addBulk", books });
    showToast("Imported " + (data.added != null ? data.added : books.length) + ".");
    await refresh();
    resetImportPanel();
  } catch (err) {
    console.error("Import failed:", err);
    showImportMsg("Import failed: " + err.message, true);
    if (doBtn) doBtn.disabled = false;
  }
}

function showImportMsg(text, isError) {
  const m = document.getElementById("bt-import-msg");
  m.textContent = text;
  m.hidden = false;
  m.className = "bt-form-msg" + (isError ? " bt-form-msg-error" : "");
}
function hideImportMsg() { document.getElementById("bt-import-msg").hidden = true; }


// ============================================================
// RENDER LIBRARY
// ============================================================
function render() {
  let books = allBooks.slice();
  if (currentFilter !== "all") books = books.filter(b => b.status === currentFilter);
  if (currentSearch) {
    books = books.filter(b =>
      b.title.toLowerCase().includes(currentSearch) ||
      b.author.toLowerCase().includes(currentSearch)
    );
  }
  books.sort(sorter(currentSort));

  const grid = document.getElementById("bt-grid");
  if (!books.length) { grid.innerHTML = `<p class="bt-empty">No books match.</p>`; return; }
  grid.innerHTML = books.map(cardHTML).join("");
  grid.querySelectorAll("img.bt-cover-img").forEach(img => {
    img.addEventListener("error", () => handleCoverError(img));
  });
}

function sorter(mode) {
  return (a, b) => {
    switch (mode) {
      case "date-desc": return (b.finished || b.started || "").localeCompare(a.finished || a.started || "");
      case "date-asc":  return (a.finished || a.started || "").localeCompare(b.finished || b.started || "");
      case "rating-desc": return (b.rating || 0) - (a.rating || 0);
      case "title": return a.title.localeCompare(b.title);
      case "author": return a.author.localeCompare(b.author);
      default: return 0;
    }
  };
}

const STATUS_LABELS = { reading: "Reading", read: "Read", tbr: "To read", dnf: "DNF" };

/* Resolve a book's cover source: ISBN-derived (preferred) -> override -> "".
   The ?default=false forces a 404 the <img> onerror can catch. */
function coverSrcFor(b) {
  return b.isbn
    ? `https://covers.openlibrary.org/b/isbn/${b.isbn}-M.jpg?default=false`
    : (b.coverOverride || "");
}

/* Inner markup for a cover box: <img> with override fallback, or a text
   placeholder when there's no source. Shared by grid + shelf cards. */
function coverInnerFor(b) {
  const coverSrc = coverSrcFor(b);
  return coverSrc
    ? `<img class="bt-cover-img" src="${escapeAttr(coverSrc)}" data-override="${escapeAttr(b.coverOverride)}" alt="${escapeAttr(b.title)} cover" loading="lazy" />`
    : `<span>${escapeHTML(b.title)}</span>`;
}

function libbyURL(b) {
  // Title/author only — never ISBN. A print ISBN (what enrichment fetches) rarely
  // matches the library's licensed ebook/audiobook edition (own ISBN), so ISBN
  // search on OverDrive tends to return zero hits. Title+author matches whatever
  // edition DCPL actually licensed; author dropped when "Unknown" → title-only.
  const q = [b.title, (b.author && b.author !== "Unknown") ? b.author : ""]
    .filter(Boolean)
    .join(" ");
  return `https://libbyapp.com/search/${LIBBY_LIBRARY}/search/scope-auto/query-${encodeURIComponent(q)}/page-1`;
}

function cardHTML(b) {
  const statusLabel = STATUS_LABELS[b.status];
  const stars = b.rating ? "★".repeat(b.rating) + "☆".repeat(5 - b.rating) : "";
  // Edit/delete need a stable id to target the row. Older rows all have ids;
  // a row without one (shouldn't happen post-Phase-0) simply gets no actions.
  const actions = b.id ? `
      <div class="bt-card-actions">
        <button type="button" class="bt-icon-btn bt-edit" data-id="${escapeAttr(b.id)}" aria-label="Edit ${escapeAttr(b.title)}" title="Edit">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button type="button" class="bt-icon-btn bt-delete" data-id="${escapeAttr(b.id)}" aria-label="Delete ${escapeAttr(b.title)}" title="Delete">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>` : "";
  return `
    <article class="bt-card" data-status="${b.status}" data-id="${escapeAttr(b.id || "")}">
      ${actions}
      <div class="bt-cover">${coverInnerFor(b)}</div>
      <h3 class="bt-bk-title">${escapeHTML(b.title)}</h3>
      <p class="bt-bk-author">${escapeHTML(b.author)}</p>
      <div class="bt-row">
        <span class="bt-pill ${b.status}">${statusLabel}</span>
        <span class="bt-rating" aria-label="${b.rating ? b.rating + ' of 5 stars' : 'unrated'}">${stars}</span>
      </div>
      <a class="bt-libby" href="${escapeAttr(libbyURL(b))}" target="_blank" rel="noopener noreferrer">Find at DCPL ↗</a>
    </article>`;
}

function handleCoverError(img) {
  const override = img.dataset.override;
  if (override && img.src !== override) { img.src = override; return; }
  const title = img.alt.replace(/ cover$/, "");
  img.parentElement.innerHTML = `<span>${escapeHTML(title)}</span>`;
}

// ============================================================
// CAROUSELS (themed shelves)
// ------------------------------------------------------------
// First-class, orthogonal to status: built once from the full library, not
// from the status-filtered view. A book appears on every shelf it's tagged
// with (carousel is a comma-separated multi-tag, parsed in normalize()).
// Shelf order = first appearance of each tag in the data (curator's order).
// ============================================================

/* Pure: group books into ordered shelves by carousel tag.
   Returns [{ name, books }] preserving first-seen tag order. */
function buildShelves(books) {
  const order = [];
  const byTag = new Map();
  books.forEach(b => {
    (b.carousels || []).forEach(tag => {
      if (!byTag.has(tag)) { byTag.set(tag, []); order.push(tag); }
      byTag.get(tag).push(b);
    });
  });
  return order.map(name => ({ name, books: byTag.get(name) }));
}

/* Pure: HTML for one shelf. Count is a quiet companion to the title; the
   right-edge fade (CSS) is the cue that the row scrolls. */
function shelfHTML(shelf) {
  const n = shelf.books.length;
  const cards = shelf.books.map(shelfCardHTML).join("");
  return `
    <section class="bt-shelf">
      <div class="bt-shelf-head">
        <h2 class="bt-shelf-title">${escapeHTML(shelf.name)}</h2>
        <span class="bt-shelf-count">${n} ${n === 1 ? "book" : "books"}</span>
      </div>
      <div class="bt-shelf-scroller-wrap">
        <div class="bt-shelf-scroller" tabindex="0" role="list" aria-label="${escapeAttr(shelf.name)} shelf">
          ${cards}
        </div>
      </div>
    </section>`;
}

/* Compact shelf card. Reuses the shared cover logic so ISBN-derived covers,
   overrides, and text placeholders behave exactly like the grid. */
function shelfCardHTML(b) {
  const statusLabel = STATUS_LABELS[b.status];
  return `
    <article class="bt-shelf-card" role="listitem" data-status="${b.status}">
      <div class="bt-cover">${coverInnerFor(b)}</div>
      <h3 class="bt-shelf-bk-title" title="${escapeAttr(b.title)}">${escapeHTML(b.title)}</h3>
      <p class="bt-shelf-bk-author">${escapeHTML(b.author)}</p>
      <span class="bt-pill ${b.status}">${statusLabel}</span>
      <a class="bt-libby" href="${escapeAttr(libbyURL(b))}" target="_blank" rel="noopener noreferrer">Find at DCPL ↗</a>
    </article>`;
}

function renderCarousels(books) {
  const host = document.getElementById("bt-shelves");
  if (!host) return;
  const shelves = buildShelves(books);
  if (!shelves.length) { host.hidden = true; host.innerHTML = ""; return; }

  host.hidden = false;
  host.innerHTML = shelves.map(shelfHTML).join("");
  host.querySelectorAll("img.bt-cover-img").forEach(img => {
    img.addEventListener("error", () => handleCoverError(img));
  });
}

function renderStats(books) {
  const year = new Date().getFullYear();
  const readThisYear = books.filter(b => b.status === "read" && b.finished && b.finished.startsWith(String(year))).length;
  const reading = books.filter(b => b.status === "reading").length;
  const tbr = books.filter(b => b.status === "tbr").length;
  const rated = books.filter(b => b.status === "read" && b.rating);
  const avg = rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(1) : "—";
  document.getElementById("bt-stats").innerHTML = `
    <div class="bt-stat"><div class="bt-stat-label">Read in ${year}</div><div class="bt-stat-val">${readThisYear}</div></div>
    <div class="bt-stat"><div class="bt-stat-label">Currently reading</div><div class="bt-stat-val">${reading}</div></div>
    <div class="bt-stat"><div class="bt-stat-label">To be read</div><div class="bt-stat-val">${tbr}</div></div>
    <div class="bt-stat"><div class="bt-stat-label">Avg rating</div><div class="bt-stat-val">${avg}</div></div>`;
}

// ---- Helpers ----
function showEmpty(msg) { document.getElementById("bt-grid").innerHTML = `<p class="bt-empty">${escapeHTML(msg)}</p>`; }
function showError(msg) { document.getElementById("bt-grid").innerHTML = `<p class="bt-error">${escapeHTML(msg)}</p>`; }
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(s) { return escapeHTML(s); }
