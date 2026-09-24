import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const DB_NAME = "paper-reader-db",
  STORE = "pdfs";
let db = null,
  pdfDoc = null,
  markdownContent = "",
  currentBook = null,
  currentPage = 1,
  scale = 1.25,
  rotation = 0,
  pageColor = "paper",
  renderTask = null,
  isRotating = false,
  searchToken = 0,
  renderToken = 0,
  searchMatches = [],
  searchQuery = "",
  searchIndex = -1,
  annotationColor = "yellow",
  inkOpacity = Number(localStorage.getItem("paper.ink-opacity") || 0.82),
  inkWidth = Number(localStorage.getItem("paper.ink-width") || 3),
  annotationFilter = "all",
  inkTool = "highlight",
  markerMode = false,
  eraserMode = false,
  annotationSelectMode = false,
  selectedAnnotationId = null,
  reflowMode = false,
  captureStart = null,
  aiImage = "",
  aiImagePage = 0,
  localAiEngine = null,
  localAiLoading = null,
  localAiWorker = null,
  visionAiEngine = null,
  visionAiLoading = null,
  visionAiWorker = null,
  builtInAiSession = null,
  builtInVisionSession = null,
  aiSelection = "",
  aiAnswerRaw = "",
  pendingNote = null,
  aiAbortController = null,
  aiScope = "selection",
  aiMessages = [],
  aiSourcePages = [],
  documentContextIndex = null,
  documentContextIndexId = "",
  documentIndexLoading = null,
  thumbObserver = null,
  thumbQueue = [],
  thumbRunning = 0,
  thumbGeneration = 0,
  thumbRenderTasks = new Set(),
  lastThumbPage = 0,
  scrubFrame = 0,
  scrubTarget = 1,
  thumbScrubStart = null,
  thumbWasDragged = false;

let inkStroke = null;

let annotationUndo = [];
let annotationRedo = [];
let wheelZoomFrame = 0;
let wheelZoomDelta = 0;
let wheelZoomAnchor = null;
let pinchGesture = null;
let layoutRefitTimer = 0;
let readingSession = { bookId: "", page: 1, lastTick: 0, active: false };
let readingIdleTimer = 0;
let readingStatsRefreshTimer = 0;
let pageRenderPending = null;
let pageRenderActive = false;
let pageRenderRequestId = 0;
let navigationDirection = 1;
let prefetchHandle = 0;
const pageProxyCache = new Map();
const textContentCache = new Map();
let navBackStack = [];
let navForwardStack = [];
let viewMode = "single"; // "single" | "double" | "continuous"
let continuousObserver = null;
let continuousRendered = new Set();
let continuousScrollFrame = 0;
let continuousResizeObserver = null;
let presentationMode = false;
let searchOptions = { caseSensitive: false, wholeWord: false, regex: false };
let searchScope = "document";
let searchRawQuery = "";
let searchRegex = null;
let searchSignature = "";
let preserveSearchOnOpen = false;
let librarySearchToken = 0;

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.15;
const READING_IDLE_MS = 75_000;
const DEFAULT_PAGE_READING_MS = 105_000;
const PAGE_CACHE_LIMIT = 12;
const TEXT_CACHE_LIMIT = 8;
const INK_TOOL_LABELS = {
  pen: "Pluma",
  highlight: "Marcador",
  underline: "Subrayador",
  wavy: "Subrayador ondulado",
  strike: "Tachado",
  box: "Recuadro",
  arrow: "Flecha",
};
const DEFAULT_INK_STYLES = {
  pen: { color: "red", opacity: 0.88, width: 3 },
  highlight: { color: annotationColor, opacity: inkOpacity, width: inkWidth },
  underline: { color: "blue", opacity: 0.88, width: 2 },
  wavy: { color: "red", opacity: 0.88, width: 2 },
  strike: { color: "red", opacity: 0.88, width: 2 },
  box: { color: "orange", opacity: 0.88, width: 3 },
  arrow: { color: "green", opacity: 0.88, width: 3 },
};
const storedInkStyles = getJSON("paper.ink-tool-styles", {});
const inkToolStyles = Object.fromEntries(
  Object.entries(DEFAULT_INK_STYLES).map(([tool, defaults]) => [
    tool,
    { ...defaults, ...(storedInkStyles[tool] || {}) },
  ]),
);

function persistInkToolStyles() {
  setJSON("paper.ink-tool-styles", inkToolStyles);
}

function applyInkToolStyle(tool = inkTool) {
  const style = inkToolStyles[tool] || DEFAULT_INK_STYLES.highlight;
  annotationColor = style.color;
  inkOpacity = Number(style.opacity);
  inkWidth = Number(style.width);
  localStorage.setItem("paper.ink-opacity", String(inkOpacity));
  localStorage.setItem("paper.ink-width", String(inkWidth));
}

function updateCurrentInkToolStyle(patch) {
  inkToolStyles[inkTool] = { ...inkToolStyles[inkTool], ...patch };
  persistInkToolStyles();
  applyInkToolStyle();
}

function toast(msg) {
  const e = $("toast");
  e.textContent = msg;
  e.classList.add("show");
  clearTimeout(e.t);
  e.t = setTimeout(() => e.classList.remove("show"), 1600);
}
function showLoader(
  show,
  title = "Abriendo PDF…",
  text = "Preparando documento",
) {
  $("loader").classList.toggle("show", show);
  $("loaderTitle").textContent = title;
  $("loaderText").textContent = text;
}
function key(id, suffix) {
  return `paper.${id}.${suffix}`;
}
function getJSON(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
  } catch {
    return d;
  }
}
function setJSON(k, v) {
  localStorage.setItem(k, JSON.stringify(v));
}
function bookId(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function getReadingStats(id) {
  return getJSON(key(id, "reading-stats"), {
    totalMs: 0,
    pageMs: {},
    pageChars: {},
    sessions: 0,
    lastReadAt: 0,
  });
}
function saveReadingStats(id, stats) {
  setJSON(key(id, "reading-stats"), stats);
}
function flushReadingSession(pause = false) {
  if (!readingSession.active || !readingSession.bookId || !readingSession.lastTick) {
    if (pause) readingSession.active = false;
    return;
  }
  const now = Date.now();
  const elapsed = Math.max(0, Math.min(30_000, now - readingSession.lastTick));
  if (elapsed >= 250) {
    const stats = getReadingStats(readingSession.bookId);
    const page = String(readingSession.page || 1);
    stats.totalMs = Number(stats.totalMs || 0) + elapsed;
    stats.pageMs[page] = Number(stats.pageMs[page] || 0) + elapsed;
    stats.lastReadAt = now;
    saveReadingStats(readingSession.bookId, stats);
  }
  readingSession.lastTick = now;
  if (pause) readingSession.active = false;
}
function canTrackReading() {
  return Boolean(
    currentBook &&
    $("libraryPanel")?.hidden &&
    document.visibilityState === "visible" &&
    document.hasFocus(),
  );
}
function markReadingActivity() {
  if (!canTrackReading()) return;
  if (readingSession.bookId !== currentBook.id) {
    flushReadingSession(true);
    readingSession = { bookId: currentBook.id, page: currentPage, lastTick: Date.now(), active: true };
    const stats = getReadingStats(currentBook.id);
    stats.sessions = Number(stats.sessions || 0) + 1;
    stats.lastReadAt = Date.now();
    saveReadingStats(currentBook.id, stats);
  } else {
    flushReadingSession(false);
    readingSession.page = currentPage;
    readingSession.lastTick = Date.now();
    readingSession.active = true;
  }
  clearTimeout(readingIdleTimer);
  readingIdleTimer = setTimeout(() => flushReadingSession(true), READING_IDLE_MS);
}
function recordPageDensity(pageNumber, textContent) {
  if (!currentBook || !textContent?.items) return;
  const chars = textContent.items.reduce((sum, item) => sum + (item.str?.trim().length || 0), 0);
  if (!chars) return;
  const stats = getReadingStats(currentBook.id);
  if (Number(stats.pageChars?.[pageNumber]) === chars) return;
  stats.pageChars ||= {};
  stats.pageChars[pageNumber] = chars;
  saveReadingStats(currentBook.id, stats);
}
function formatReadingDuration(ms, compact = false) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes < 1) return compact ? "<1 min" : "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return compact ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${hours} h${rest ? ` ${rest} min` : ""}`;
}
function readingEstimate(book) {
  const stats = getReadingStats(book.id);
  const page = Math.max(1, Math.min(Number(localStorage.getItem(key(book.id, "page")) || 1), book.pages || 1));
  const pageTimes = Object.entries(stats.pageMs || {}).filter(([, ms]) => Number(ms) >= 5_000);
  const knownChars = Object.values(stats.pageChars || {}).map(Number).filter((value) => value > 0);
  const averageChars = knownChars.length ? knownChars.reduce((a, b) => a + b, 0) / knownChars.length : 1_900;
  const observedMs = pageTimes.reduce((sum, [, ms]) => sum + Number(ms), 0);
  const observedChars = pageTimes.reduce((sum, [p]) => sum + Number(stats.pageChars?.[p] || averageChars), 0);
  const msPerChar = observedChars > 0 && pageTimes.length
    ? Math.max(18, Math.min(220, observedMs / observedChars))
    : DEFAULT_PAGE_READING_MS / averageChars;
  const averagePageMs = pageTimes.length
    ? Math.max(30_000, Math.min(600_000, observedMs / pageTimes.length))
    : DEFAULT_PAGE_READING_MS;
  let remainingMs = 0;
  const totalPages = Number(book.pages || 1);
  for (let p = page + 1; p <= totalPages; p++) {
    const chars = Number(stats.pageChars?.[p] || averageChars);
    const densityEstimate = chars * msPerChar;
    remainingMs += pageTimes.length ? Math.max(averagePageMs * 0.45, Math.min(averagePageMs * 2.2, densityEstimate)) : densityEstimate;
  }
  if (page < totalPages) remainingMs += averagePageMs * 0.45;
  return {
    ...stats,
    page,
    progress: totalPages ? Math.round((page / totalPages) * 100) : 0,
    averagePageMs,
    averageChars,
    remainingMs,
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE))
        r.result.createObjectStore(STORE, { keyPath: "id" });
    };
    r.onsuccess = () => {
      db = r.result;
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
}
function dbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbGet(id) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function dbAll() {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}
function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteBook(id) {
  if (!confirm("¿Eliminar este PDF y sus datos locales?")) return;
  await dbDelete(id);
  localStorage.removeItem(key(id, "bookmarks"));
  localStorage.removeItem(key(id, "annotations"));
  localStorage.removeItem(key(id, "reading-stats"));
  if (currentBook?.id === id) {
    resetRenderEngine();
    pdfDoc = null;
    currentBook = null;
    showEmpty();
  }
  await renderLibrary();
  toast("PDF eliminado de la biblioteca");
}
async function renderLibrary() {
  flushReadingSession(false);
  const books = await dbAll();
  const query = ($("librarySearch")?.value || "").trim().toLocaleLowerCase();
  const type = $("libraryType")?.value || "all";
  const sort = $("librarySort")?.value || "recent";
  const estimates = new Map(books.map((book) => [book.id, readingEstimate(book)]));
  const visibleBooks = books
    .filter((book) => (!query || book.name.toLocaleLowerCase().includes(query)) && (type === "all" || (book.kind || "pdf") === type))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
      if (sort === "progress") return estimates.get(b.id).progress - estimates.get(a.id).progress;
      if (sort === "remaining") return estimates.get(a.id).remainingMs - estimates.get(b.id).remainingMs;
      return b.openedAt - a.openedAt;
    });
  if ($("librarySummary")) {
    const pdfs = books.filter((book) => book.kind !== "markdown").length;
    const markdown = books.length - pdfs;
    const totalMs = [...estimates.values()].reduce((sum, stats) => sum + Number(stats.totalMs || 0), 0);
    const remainingMs = [...estimates.values()].reduce((sum, stats) => sum + Number(stats.remainingMs || 0), 0);
    const pagesRead = books.reduce((sum, book) => sum + Math.min(book.pages || 1, estimates.get(book.id).page), 0);
    const pagesTotal = books.reduce((sum, book) => sum + Number(book.pages || 1), 0);
    $("librarySummary").innerHTML = `<div class="library-stat primary"><small>Biblioteca</small><strong>${books.length}</strong><span>${pdfs} PDF · ${markdown} MD</span></div><div class="library-stat"><small>Leído</small><strong>${formatReadingDuration(totalMs, true)}</strong><span>${pagesRead} de ${pagesTotal} páginas</span></div><div class="library-stat"><small>Tiempo restante</small><strong>${formatReadingDuration(remainingMs, true)}</strong><span>Estimación adaptativa</span></div>`;
  }
  $("library").innerHTML = visibleBooks.length
    ? visibleBooks
        .map((b) => {
          const stats = estimates.get(b.id),
            page = stats.page,
            progress = stats.progress;
          const type = b.kind === "markdown" ? "MD" : "PDF";
          const readingMeta = stats.totalMs >= 5_000
            ? `${formatReadingDuration(stats.averagePageMs, true)}/pág. · ${Math.round(stats.averageChars / 100) / 10}k car./pág.`
            : `Estimación por longitud · ${Math.round(stats.averageChars / 100) / 10}k car./pág.`;
          return `<article class="book-entry ${currentBook?.id === b.id ? "current" : ""}"><button class="book ${currentBook?.id === b.id ? "active" : ""}" data-id="${encodeURIComponent(b.id)}"><span class="book-cover ${type === "MD" ? "markdown" : ""}"><i>${type}</i><b></b><b></b><b></b></span><span class="book-copy"><span class="book-type">${type === "MD" ? "Documento Markdown" : "Documento PDF"}</span><strong>${escapeHtml(b.name)}</strong><small>${b.pages ? `Página ${page} de ${b.pages}` : new Date(b.openedAt).toLocaleDateString()}</small><span class="book-reading"><b>${progress >= 100 ? "Completado" : `≈ ${formatReadingDuration(stats.remainingMs, true)} restantes`}</b><small>${readingMeta}</small></span><i class="book-progress"><b style="width:${progress}%"></b></i><span class="book-continue">${currentBook?.id === b.id ? "Abierto ahora" : progress ? "Continuar leyendo →" : "Abrir documento →"}</span></span><em>${progress}%</em></button><button class="btn icon book-remove" data-remove-book="${encodeURIComponent(b.id)}" aria-label="Eliminar ${escapeHtml(b.name)}" title="Eliminar documento">×</button></article>`;
        })
        .join("")
    : `<div class="library-empty"><span>${query ? "⌕" : "＋"}</span><strong>${query ? "No hay coincidencias" : "Tu biblioteca está vacía"}</strong><p>${query ? "Prueba con otro nombre de archivo." : "Añade un PDF o Markdown para empezar a leer."}</p></div>`;
  document
    .querySelectorAll(".book[data-id]")
    .forEach(
      (el) =>
        (el.onclick = () => openStored(decodeURIComponent(el.dataset.id))),
    );
  document
    .querySelectorAll("[data-remove-book]")
    .forEach(
      (el) =>
        (el.onclick = () =>
          deleteBook(decodeURIComponent(el.dataset.removeBook))),
    );
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function addFile(file) {
  if (!file) return;
  const isMarkdown = /\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown";
  if (
    !(
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf") ||
      isMarkdown
    )
  )
    return toast("Selecciona un PDF o Markdown");
  showLoader(true, `Guardando ${isMarkdown ? "Markdown" : "PDF"}…`, "Se queda solo en este dispositivo");
  try {
    const id = bookId(file),
      buffer = await file.arrayBuffer();
    await dbPut({
      id,
      name: file.name,
      kind: isMarkdown ? "markdown" : "pdf",
      blob: new Blob([buffer], { type: isMarkdown ? "text/markdown" : "application/pdf" }),
      openedAt: Date.now(),
      pages: isMarkdown ? 1 : null,
    });
    await openStored(id);
  } catch (e) {
    console.error(e);
    toast("No se pudo guardar el PDF");
  } finally {
    showLoader(false);
  }
}
function markdownToHtml(source) {
  const lines = source.replace(/\r/g, "").split("\n");
  const html = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { html.push("</ul>"); listOpen = false; } };
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^[-*+]\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      if (!listOpen) { html.push("<ul>"); listOpen = true; }
      html.push(`<li>${escapeHtml(item[1])}</li>`);
    } else if (line.trim()) {
      closeList();
      html.push(`<p>${escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>")}</p>`);
    } else closeList();
  }
  closeList();
  return html.join("") || "<p>Documento Markdown vacío.</p>";
}
async function openMarkdownStored(rec) {
  flushReadingSession(true);
  flushNotebook();
  setStickyPlacement(false);
  if (activeStickyId) closeStickyEditor();
  markdownContent = await rec.blob.text();
  resetRenderEngine();
  teardownContinuous();
  viewMode = "single";
  $("continuousView").hidden = true;
  $("facingWrap").hidden = true;
  $("viewer").classList.remove("double-mode");
  pdfDoc = null;
  currentBook = rec;
  resetAiDocumentState();
  resetAnnotationHistory();
  migrateLegacyPageNotes();
  currentPage = 1;
  reflowMode = true;
  document.body.classList.add("reflow-mode");
  $("markerModeBtn").disabled = true;
  $("eraserModeBtn").disabled = true;
  rec.openedAt = Date.now();
  rec.pages = 1;
  await dbPut(rec);
  const markdownStats = getReadingStats(rec.id);
  markdownStats.pageChars[1] = markdownContent.replace(/[#*_`>\-]/g, "").length;
  saveReadingStats(rec.id, markdownStats);
  $("emptyState").hidden = true;
  $("canvasWrap").hidden = true;
  $("reflowReader").hidden = false;
  document.body.classList.add("has-doc");
  $("reflowReader").innerHTML = markdownToHtml(markdownContent);
  $("docTitle").textContent = rec.name;
  $("docMeta").textContent = "Markdown · guardado localmente";
  $("pageStatus").textContent = "Modo lectura Markdown";
  $("pageStatus").hidden = false;
  $("pageTotal").textContent = "";
  $("pageJump").hidden = true;
  $("toolbarPage").disabled = true;
  $("toolbarPrev").disabled = true;
  $("toolbarNext").disabled = true;
  $("pageScrubber").disabled = true;
  $("reflowControls").hidden = false;
  document.querySelectorAll("[data-reading-mode]").forEach((button) =>
    button.classList.toggle("active", button.dataset.readingMode === "reflow"),
  );
  applyReflowPreferences();
  renderBookmarks();
  renderAnnotationList();
  await renderLibrary();
  document.body.classList.remove("sidebar-open");
  markReadingActivity();
}
async function openStored(id) {
  showLoader(true);
  try {
    if (currentBook?.id !== id) flushReadingSession(true);
    if (ttsActive && currentBook?.id !== id) stopReadAloud();
    flushNotebook();
    setStickyPlacement(false);
    if (activeStickyId) closeStickyEditor();
    if (currentBook?.id !== id) setAutoScroll(false);
    const rec = await dbGet(id);
    if (!rec) throw new Error("Documento no encontrado");
    if (rec.kind === "markdown") {
      await openMarkdownStored(rec);
      return;
    }
    markdownContent = "";
    reflowMode = localStorage.getItem("paper.reading-mode") === "reflow";
    document.body.classList.toggle("reflow-mode", reflowMode);
    $("markerModeBtn").disabled = reflowMode;
    $("eraserModeBtn").disabled = reflowMode;
    $("reflowControls").hidden = !reflowMode;
    document.querySelectorAll("[data-reading-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.readingMode === (reflowMode ? "reflow" : "pdf")),
    );
    resetRenderEngine();
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    rec.pages = pdfDoc.numPages;
    rec.openedAt = Date.now();
    await dbPut(rec);
    currentBook = rec;
    resetAiDocumentState();
    resetAnnotationHistory();
    migrateLegacyPageNotes();
    resetNavHistory();
    // Empezar siempre desde una vista limpia; el modo guardado se aplica al final.
    teardownContinuous();
    viewMode = "single";
    $("continuousView").hidden = true;
    $("facingWrap").hidden = true;
    $("viewer").classList.remove("double-mode");
    resetThumbnails();
    // Al abrir desde un resultado de búsqueda en la biblioteca conservamos las
    // coincidencias para poder seguir navegando entre documentos.
    if (preserveSearchOnOpen) {
      preserveSearchOnOpen = false;
    } else {
      searchQuery = "";
      searchRawQuery = "";
      searchRegex = null;
      searchSignature = "";
      searchMatches = [];
      searchIndex = -1;
      renderSearchResults();
    }
    currentPage = Math.min(
      Number(localStorage.getItem(key(id, "page")) || 1),
      pdfDoc.numPages,
    );
    const storedScale = Number(localStorage.getItem(key(id, "scale")));
    scale = storedScale > 0 ? storedScale : 1.25;
    rotation = Number(localStorage.getItem(key(id, "rotation")) || 0) % 360;
    $("emptyState").hidden = true;
    $("canvasWrap").hidden = false;
    document.body.classList.add("has-doc");
    // El zoom se decide por modo: los documentos sin modo guardado (o con un
    // zoom manual sin escala) abren en «Automático», que siempre cabe bien.
    zoomMode = localStorage.getItem(key(id, "zoom-mode")) || "auto";
    if (zoomMode === "custom" && !(storedScale > 0)) zoomMode = "auto";
    if (zoomMode !== "custom") scale = await computeZoomForMode(zoomMode);
    $("docTitle").textContent = rec.name;
    $("docMeta").textContent =
      `${pdfDoc.numPages} páginas · guardado localmente`;
    await renderPage(currentPage);
    const storedViewMode = localStorage.getItem("paper.view-mode") || "single";
    if (!reflowMode && storedViewMode !== "single") await setViewMode(storedViewMode, { silent: true });
    else document.querySelectorAll("[data-view-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.viewMode === viewMode),
    );
    renderBookmarks();
    renderAnnotationList();
    await renderOutline();
    renderLibrary();
    if (!$("notebookPanel").hidden) renderNotebook();
    if (localStorage.getItem("paper.ruler") === "1") setReadingRuler(true, true);
    updateStudyLaunch();
    document.body.classList.remove("sidebar-open");
    markReadingActivity();
  } catch (e) {
    console.error(e);
    toast("No se pudo abrir el PDF");
  } finally {
    showLoader(false);
  }
}

function cancelScheduledPrefetch() {
  if (!prefetchHandle) return;
  if ("cancelIdleCallback" in window) window.cancelIdleCallback(prefetchHandle);
  else clearTimeout(prefetchHandle);
  prefetchHandle = 0;
}
function trimLruCache(cache, limit) {
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}
function touchCache(cache, cacheKey, value, limit) {
  cache.delete(cacheKey);
  cache.set(cacheKey, value);
  trimLruCache(cache, limit);
  return value;
}
function getCachedPage(pageNumber) {
  if (!pdfDoc) return Promise.reject(new Error("No hay PDF abierto"));
  if (pageProxyCache.has(pageNumber)) {
    const cached = pageProxyCache.get(pageNumber);
    return touchCache(pageProxyCache, pageNumber, cached, PAGE_CACHE_LIMIT);
  }
  const documentRef = pdfDoc;
  const request = documentRef.getPage(pageNumber).catch((error) => {
    if (pageProxyCache.get(pageNumber) === request) pageProxyCache.delete(pageNumber);
    throw error;
  });
  touchCache(pageProxyCache, pageNumber, request, PAGE_CACHE_LIMIT);
  return request;
}
function getCachedTextContent(page) {
  const pageNumber = page.pageNumber;
  if (textContentCache.has(pageNumber)) {
    const cached = textContentCache.get(pageNumber);
    return touchCache(textContentCache, pageNumber, cached, TEXT_CACHE_LIMIT);
  }
  const request = page.getTextContent().catch((error) => {
    if (textContentCache.get(pageNumber) === request) textContentCache.delete(pageNumber);
    throw error;
  });
  touchCache(textContentCache, pageNumber, request, TEXT_CACHE_LIMIT);
  return request;
}
function resetRenderEngine() {
  pageRenderRequestId++;
  cancelScheduledPrefetch();
  cancelThumbnailWork();
  if (renderTask) {
    try { renderTask.cancel(); } catch {}
  }
  renderTask = null;
  if (pageRenderPending) pageRenderPending.resolve(false);
  pageRenderPending = null;
  pageProxyCache.clear();
  textContentCache.clear();
}
function renderPage(num, options = {}) {
  if (!pdfDoc) return Promise.resolve(false);
  const pageNumber = Math.max(1, Math.min(pdfDoc.numPages, Number(num) || 1));
  // En scroll continuo, "renderizar una página" equivale a desplazarse a ella:
  // el resto de la navegación (teclas, enlaces, índice…) sigue igual.
  if (viewMode === "continuous" && !reflowMode) {
    scrollToContinuousPage(pageNumber, options);
    return Promise.resolve(true);
  }
  const requestId = ++pageRenderRequestId;
  return new Promise((resolve) => {
    if (pageRenderPending) pageRenderPending.resolve(false);
    pageRenderPending = { pageNumber, options, requestId, resolve };
    cancelScheduledPrefetch();
    if (renderTask) {
      try { renderTask.cancel(); } catch {}
    }
    drainPageRenderQueue();
  });
}
// Actualiza toda la barra de página (pie, cabecera, progreso) a partir de
// currentPage. Compartido por el modo página única, doble y scroll continuo.
function updatePageChrome() {
  if (!pdfDoc) return;
  $("pageStatus").textContent = `Página ${currentPage} de ${pdfDoc.numPages}`;
  $("pageStatus").hidden = true;
  $("pageTotal").textContent = `de ${pdfDoc.numPages}`;
  updateBookmarkButton();
  $("pageJump").value = currentPage;
  $("pageJump").max = pdfDoc.numPages;
  $("pageJump").hidden = false;
  $("toolbarPage").value = currentPage;
  $("toolbarPage").max = pdfDoc.numPages;
  $("toolbarPage").disabled = false;
  $("toolbarPageCount").textContent = `/ ${pdfDoc.numPages}`;
  $("toolbarPrev").disabled = currentPage === 1;
  $("toolbarNext").disabled = currentPage === pdfDoc.numPages;
  $("pageScrubber").max = pdfDoc.numPages;
  $("pageScrubber").value = currentPage;
  $("pageScrubber").disabled = false;
  $("progressBar").style.width = `${(currentPage / pdfDoc.numPages) * 100}%`;
  $("prevBtn").disabled = currentPage === 1;
  $("nextBtn").disabled = currentPage === pdfDoc.numPages;
  syncNotebookPage();
  updateRemainingTime();
  scheduleRuler();
}
// ---- Historial de vistas (atrás / adelante) ----
// Registra los saltos "no secuenciales" (índice, enlaces, búsqueda, marcadores)
// para poder volver al punto anterior, como el "vista previa" de un lector real.
function resetNavHistory() {
  navBackStack = [];
  navForwardStack = [];
  updateNavHistoryButtons();
}
function updateNavHistoryButtons() {
  const back = $("navBack"),
    forward = $("navForward");
  if (back) back.disabled = navBackStack.length === 0;
  if (forward) forward.disabled = navForwardStack.length === 0;
}
function jumpToPage(page, options = {}) {
  if (!pdfDoc) return Promise.resolve(false);
  const target = Math.max(1, Math.min(pdfDoc.numPages, Number(page) || 1));
  if (target === currentPage) return Promise.resolve(false);
  navBackStack.push(currentPage);
  if (navBackStack.length > 120) navBackStack.shift();
  navForwardStack = [];
  updateNavHistoryButtons();
  return renderPage(target, options);
}
function navigateBack() {
  if (!navBackStack.length) return;
  navForwardStack.push(currentPage);
  const target = navBackStack.pop();
  updateNavHistoryButtons();
  renderPage(target);
}
function navigateForward() {
  if (!navForwardStack.length) return;
  navBackStack.push(currentPage);
  const target = navForwardStack.pop();
  updateNavHistoryButtons();
  renderPage(target);
}
// ---- Motor de dibujo reutilizable (página única, doble y continuo) ----
// Dibuja una página en un canvas + capa de texto + capa de enlaces dados,
// sin tocar el estado global. `token` permite descartar renders obsoletos.
async function renderPageGraphics(pageNumber, targets, token) {
  const page = await getCachedPage(pageNumber);
  if (token !== undefined && token !== renderToken) return null;
  const viewport = page.getViewport({ scale, rotation });
  const targetDpr = Math.min(window.devicePixelRatio || 1, 3);
  const dpr = Math.min(targetDpr, Math.sqrt(24_000_000 / (viewport.width * viewport.height)));
  const { canvas, textLayer, linkLayer, sizeTarget } = targets;
  const ctx = canvas.getContext("2d");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  if (sizeTarget) {
    sizeTarget.style.width = `${viewport.width}px`;
    sizeTarget.style.height = `${viewport.height}px`;
  }
  const task = page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return null;
    throw error;
  }
  if (token !== undefined && token !== renderToken) return null;
  if (textLayer) {
    textLayer.replaceChildren();
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty("--scale-factor", String(viewport.scale));
    try {
      const content = await getCachedTextContent(page);
      const layer = new pdfjsLib.TextLayer({ textContentSource: content, container: textLayer, viewport });
      await layer.render();
    } catch {}
  }
  if (linkLayer) renderLinkLayerInto(linkLayer, page, viewport, token);
  return viewport;
}

// ---- Modo doble página (libro) ----
async function renderFacingPage(token) {
  const wrap = $("facingWrap");
  if (!wrap) return;
  const facingNumber = currentPage + 1;
  if (viewMode !== "double" || !pdfDoc || facingNumber > pdfDoc.numPages) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  try {
    await renderPageGraphics(facingNumber, {
      canvas: $("facingCanvas"),
      textLayer: $("facingTextLayer"),
      linkLayer: $("facingLinkLayer"),
      sizeTarget: wrap,
    }, token);
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") console.error("No se pudo renderizar la página enfrentada", error);
  }
}

// ---- Modo scroll continuo ----
function teardownContinuous() {
  if (continuousObserver) {
    continuousObserver.disconnect();
    continuousObserver = null;
  }
  continuousRendered = new Set();
  if (continuousScrollFrame) {
    cancelAnimationFrame(continuousScrollFrame);
    continuousScrollFrame = 0;
  }
  const container = $("continuousView");
  if (container) container.replaceChildren();
}
async function buildContinuousView() {
  const container = $("continuousView");
  if (!container || !pdfDoc) return;
  teardownContinuous();
  const first = await getCachedPage(currentPage);
  const baseViewport = first.getViewport({ scale, rotation });
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const slot = document.createElement("div");
    slot.className = "cont-page";
    slot.dataset.page = String(i);
    slot.style.width = `${baseViewport.width}px`;
    slot.style.height = `${baseViewport.height}px`;
    slot.innerHTML = `<canvas></canvas><div class="textLayer"></div><div class="link-layer"></div><span class="cont-num">${i}</span>`;
    fragment.append(slot);
  }
  container.append(fragment);
  continuousObserver = new IntersectionObserver(onContinuousIntersect, {
    root: $("viewer"),
    rootMargin: "350px 0px",
    threshold: 0.01,
  });
  container.querySelectorAll(".cont-page").forEach((slot) => continuousObserver.observe(slot));
  markContinuousCurrent();
}
function onContinuousIntersect(entries) {
  for (const entry of entries) {
    const slot = entry.target;
    const pageNumber = Number(slot.dataset.page);
    if (entry.isIntersecting) renderContinuousSlot(slot);
    else if (Math.abs(pageNumber - currentPage) > 3) unloadContinuousSlot(slot);
  }
}
async function renderContinuousSlot(slot) {
  const pageNumber = Number(slot.dataset.page);
  if (continuousRendered.has(pageNumber)) return;
  continuousRendered.add(pageNumber);
  try {
    await renderPageGraphics(pageNumber, {
      canvas: slot.querySelector("canvas"),
      textLayer: slot.querySelector(".textLayer"),
      linkLayer: slot.querySelector(".link-layer"),
      sizeTarget: slot,
    });
    if (viewMode !== "continuous") return;
  } catch {
    continuousRendered.delete(pageNumber);
  }
}
function unloadContinuousSlot(slot) {
  const pageNumber = Number(slot.dataset.page);
  if (!continuousRendered.has(pageNumber)) return;
  continuousRendered.delete(pageNumber);
  const canvas = slot.querySelector("canvas");
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = slot.style.width;
    canvas.style.height = slot.style.height;
  }
  slot.querySelector(".textLayer")?.replaceChildren();
  slot.querySelector(".link-layer")?.replaceChildren();
}
function markContinuousCurrent() {
  $("continuousView")
    ?.querySelectorAll(".cont-page")
    .forEach((slot) => slot.classList.toggle("is-current", Number(slot.dataset.page) === currentPage));
}
function scrollToContinuousPage(pageNumber, options = {}) {
  const container = $("continuousView");
  if (!container) return;
  const target = Math.max(1, Math.min(pdfDoc.numPages, pageNumber));
  const slot = container.querySelector(`.cont-page[data-page="${target}"]`);
  syncCurrentFromScroll(target);
  if (slot && options.scroll !== false) {
    $("viewer").scrollTo({ top: slot.offsetTop - 18, behavior: options.smooth === false ? "auto" : "smooth" });
  }
}
// Actualiza el estado a partir de la página visible al hacer scroll (sin
// volver a desplazar, para no crear un bucle con el propio scroll).
function syncCurrentFromScroll(pageNumber) {
  const previous = currentPage;
  if (previous !== pageNumber) {
    flushReadingSession(false);
    navigationDirection = pageNumber > previous ? 1 : -1;
  }
  currentPage = pageNumber;
  readingSession.page = currentPage;
  if (currentBook) localStorage.setItem(key(currentBook.id, "page"), String(currentPage));
  updatePageChrome();
  updateThumbSelection();
  updateOutlineSelection();
  markContinuousCurrent();
  if (presentationMode) updatePresentationCount();
}
function onContinuousScroll() {
  if (viewMode !== "continuous" || continuousScrollFrame) return;
  continuousScrollFrame = requestAnimationFrame(() => {
    continuousScrollFrame = 0;
    const viewer = $("viewer");
    const center = viewer.scrollTop + viewer.clientHeight / 2;
    let best = currentPage,
      bestDistance = Infinity;
    $("continuousView")
      .querySelectorAll(".cont-page")
      .forEach((slot) => {
        const middle = slot.offsetTop + slot.offsetHeight / 2;
        const distance = Math.abs(middle - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = Number(slot.dataset.page);
        }
      });
    if (best !== currentPage) syncCurrentFromScroll(best);
  });
}

// ---- Selector de diseño de página ----
async function setViewMode(mode, options = {}) {
  if (!["single", "double", "continuous"].includes(mode)) mode = "single";
  if (reflowMode && mode !== "single") await setReadingMode("pdf");
  const previous = viewMode;
  viewMode = mode;
  localStorage.setItem("paper.view-mode", mode);
  document.querySelectorAll("[data-view-mode]").forEach((button) =>
    button.classList.toggle("active", button.dataset.viewMode === mode),
  );
  $("viewer").classList.toggle("double-mode", mode === "double");
  // La tinta usa el motor de página única; se desactiva en scroll continuo.
  const inkDisabled = mode === "continuous" || reflowMode;
  if (inkDisabled && markerMode) toggleMarkerMode();
  if (inkDisabled && eraserMode) toggleEraserMode(false);
  $("markerModeBtn").disabled = inkDisabled;
  $("eraserModeBtn").disabled = inkDisabled;
  if (previous === "continuous" && mode !== "continuous") teardownContinuous();
  $("continuousView").hidden = mode !== "continuous";
  $("canvasWrap").hidden = mode === "continuous" || reflowMode;
  if (mode !== "double") $("facingWrap").hidden = true;
  $("reflowReader").hidden = !reflowMode;
  if (!pdfDoc) return;
  if (mode === "continuous") {
    await buildContinuousView();
    scrollToContinuousPage(currentPage, { smooth: false });
  } else {
    await renderPage(currentPage, { resetScroll: false });
  }
  if (!options.silent)
    toast(mode === "continuous" ? "Scroll continuo" : mode === "double" ? "Doble página" : "Una página");
}
function stepPage(direction) {
  const step = viewMode === "double" ? 2 : 1;
  renderPage(currentPage + direction * step);
}
// Re-dibuja la vista actual tras cambiar zoom, rotación o tamaño de ventana.
function refreshCurrentView() {
  if (!pdfDoc) return;
  if (viewMode === "continuous" && !reflowMode) {
    buildContinuousView().then(() => scrollToContinuousPage(currentPage, { smooth: false }));
  } else {
    renderPage(currentPage, { resetScroll: false });
  }
}

// ---- Modo presentación (pantalla completa, avance por clic) ----
function updatePresentationCount() {
  const count = $("pmCount");
  if (count && pdfDoc) count.textContent = `${currentPage} / ${pdfDoc.numPages}`;
}
async function enterPresentation() {
  if (!pdfDoc) return;
  presentationMode = true;
  zoomModeBeforePresentation = { mode: zoomMode, scale };
  document.body.classList.add("presentation-mode");
  if (viewMode !== "single") await setViewMode("single", { silent: true });
  updatePresentationCount();
  const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  try {
    if (request) await request.call(document.documentElement, { navigationUI: "hide" });
  } catch {}
  requestAnimationFrame(() => applyZoomMode("page", { persist: false }));
  toast("Presentación · flechas o clic para avanzar · Esc para salir");
}
async function exitPresentation() {
  presentationMode = false;
  document.body.classList.remove("presentation-mode");
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  try {
    if (fullscreenElement() && exit) await exit.call(document);
  } catch {}
  const previous = zoomModeBeforePresentation;
  zoomModeBeforePresentation = null;
  requestAnimationFrame(() => {
    if (previous?.mode === "custom") {
      zoomMode = "custom";
      scale = previous.scale;
      refreshCurrentView();
      updateZoomLabel();
    } else applyZoomMode(previous?.mode || "auto", { persist: false });
  });
}
function togglePresentation() {
  presentationMode ? exitPresentation() : enterPresentation();
}

// ---- Lectura en voz alta (Text-to-Speech) ----
const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;
let ttsActive = false;
let ttsPaused = false;
let ttsSentences = [];
let ttsSentenceIndex = 0;
let ttsRate = 1;
let ttsVoiceURI = "";
let speechVoices = [];
async function getPagePlainText(pageNumber) {
  const page = await getCachedPage(pageNumber);
  const content = await getCachedTextContent(page);
  const parts = [];
  for (const block of reflowBlocks(content.items)) {
    if (block.type === "list") parts.push(...block.items);
    else if (block.text) parts.push(block.text);
  }
  return parts.join("\n");
}
function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((paragraph) => paragraph.match(/[^.!?]+[.!?]*/g) || [paragraph])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);
}
function populateTtsVoices() {
  if (!speechSupported) return;
  speechVoices = window.speechSynthesis.getVoices();
  const select = $("ttsVoice");
  if (!select) return;
  if (!speechVoices.length) {
    select.innerHTML = "<option>Voz del sistema</option>";
    return;
  }
  select.innerHTML = speechVoices
    .map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${voice.lang}</option>`)
    .join("");
  if (!ttsVoiceURI || !speechVoices.some((voice) => voice.voiceURI === ttsVoiceURI)) {
    const spanish = speechVoices.find((voice) => /^es/i.test(voice.lang));
    ttsVoiceURI = (spanish || speechVoices[0]).voiceURI;
  }
  select.value = ttsVoiceURI;
}
function updateTtsCaption(message) {
  const caption = $("ttsCaption");
  if (!caption) return;
  if (message) {
    caption.textContent = message;
    return;
  }
  caption.innerHTML = `<b>${escapeHtml(ttsSentences[ttsSentenceIndex] || "")}</b>`;
}
async function loadPageSentences(pageNumber) {
  try {
    ttsSentences = splitSentences(await getPagePlainText(pageNumber));
  } catch {
    ttsSentences = [];
  }
  if (!ttsSentences.length) updateTtsCaption("Esta página no tiene texto para leer.");
}
function speakSentence() {
  if (!ttsActive || !speechSupported) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const text = ttsSentences[ttsSentenceIndex];
  if (text == null) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = ttsRate;
  const voice = speechVoices.find((candidate) => candidate.voiceURI === ttsVoiceURI);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.onend = () => {
    if (!ttsActive || ttsPaused) return;
    ttsSentenceIndex++;
    if (ttsSentenceIndex < ttsSentences.length) speakSentence();
    else advanceTtsPage();
  };
  ttsPaused = false;
  $("ttsPlayPause").textContent = "⏸";
  updateTtsCaption();
  synth.speak(utterance);
}
async function advanceTtsPage() {
  if (!pdfDoc || currentPage >= pdfDoc.numPages) {
    updateTtsCaption("Fin del documento.");
    stopReadAloud();
    return;
  }
  const next = currentPage + 1;
  if (viewMode === "continuous") scrollToContinuousPage(next);
  else await renderPage(next);
  await loadPageSentences(next);
  ttsSentenceIndex = 0;
  if (ttsSentences.length) speakSentence();
  else advanceTtsPage();
}
async function startReadAloud() {
  if (!speechSupported) {
    toast("Este navegador no admite lectura en voz alta");
    return;
  }
  if (!pdfDoc) return;
  ttsActive = true;
  ttsPaused = false;
  document.body.classList.add("tts-active");
  $("readAloudBtn").classList.add("active");
  $("readAloudBtn").setAttribute("aria-pressed", "true");
  $("ttsBar").hidden = false;
  populateTtsVoices();
  updateTtsCaption("Preparando lectura…");
  await loadPageSentences(currentPage);
  ttsSentenceIndex = 0;
  if (ttsSentences.length) speakSentence();
  else advanceTtsPage();
}
function stopReadAloud() {
  ttsActive = false;
  ttsPaused = false;
  if (speechSupported) window.speechSynthesis.cancel();
  document.body.classList.remove("tts-active");
  $("readAloudBtn")?.classList.remove("active");
  $("readAloudBtn")?.setAttribute("aria-pressed", "false");
  if ($("ttsBar")) $("ttsBar").hidden = true;
}
function toggleReadAloud() {
  if (ttsActive) stopReadAloud();
  else startReadAloud();
}
function toggleTtsPlayPause() {
  if (!ttsActive) {
    startReadAloud();
    return;
  }
  if (ttsPaused) {
    window.speechSynthesis.resume();
    ttsPaused = false;
    $("ttsPlayPause").textContent = "⏸";
  } else {
    window.speechSynthesis.pause();
    ttsPaused = true;
    $("ttsPlayPause").textContent = "▶";
  }
}
function ttsSkip(direction) {
  if (!ttsActive || !ttsSentences.length) return;
  ttsSentenceIndex = Math.max(0, Math.min(ttsSentences.length - 1, ttsSentenceIndex + direction));
  speakSentence();
}

// ---- Paleta de comandos (Ctrl/⌘+K) ----
// Un único punto de entrada para buscar texto, saltar a una página o sección,
// abrir documentos y ejecutar cualquier acción de la aplicación.
let paletteItems = [];
let paletteIndex = 0;
let paletteLibrary = [];
let paletteTextIndex = null;
let paletteRenderFrame = 0;
let paletteReturnFocus = null;
function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function paletteScore(query, text) {
  const q = normalizeText(query).trim();
  if (!q) return 1;
  const t = normalizeText(text);
  const at = t.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return /[\s·:(-]/.test(t[at - 1]) ? 80 : 60;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((word) => t.includes(word))) return 40;
  let cursor = 0;
  for (const char of t) {
    if (char === q[cursor]) cursor++;
    if (cursor === q.length) return 12;
  }
  return 0;
}
function paletteActions() {
  const hasPdf = Boolean(pdfDoc);
  const hasDoc = Boolean(currentBook);
  const actions = [
    { icon: "▤", title: "Abrir biblioteca", keys: "biblioteca documentos inicio home", run: () => $("homeBtn").click() },
    { icon: "＋", title: "Añadir PDF o Markdown", keys: "importar subir abrir archivo nuevo", run: () => $("fileInput").click() },
    { icon: "⤒", title: "Ir a la primera página", shortcut: ["Inicio"], when: hasPdf, run: () => jumpToPage(1) },
    { icon: "⤓", title: "Ir a la última página", shortcut: ["Fin"], when: hasPdf, run: () => jumpToPage(pdfDoc.numPages) },
    { icon: "⟲", title: "Volver a la vista anterior", shortcut: ["Alt", "←"], when: hasPdf && navBackStack.length > 0, run: navigateBack },
    { icon: "▯", title: "Diseño: una página", keys: "vista simple", when: hasPdf, run: () => setViewMode("single") },
    { icon: "▯▯", title: "Diseño: doble página (libro)", keys: "vista libro spread dos paginas", when: hasPdf, run: () => setViewMode("double") },
    { icon: "↕", title: "Diseño: scroll continuo", keys: "vista desplazamiento vertical", when: hasPdf, run: () => setViewMode("continuous") },
    { icon: "¶", title: reflowMode ? "Volver al PDF original" : "Modo lectura (texto adaptable)", keys: "reflow lectura maquetado texto fuente", shortcut: ["L"], when: hasPdf, run: () => setReadingMode(reflowMode ? "pdf" : "reflow") },
    { icon: "▶", title: "Presentación a pantalla completa", keys: "diapositivas slides", shortcut: ["P"], when: hasPdf, run: enterPresentation },
    { icon: "🔊", title: ttsActive ? "Detener lectura en voz alta" : "Leer en voz alta", keys: "tts voz audio escuchar", when: hasPdf && speechSupported, run: toggleReadAloud },
    { icon: "⛶", title: "Modo enfoque / pantalla completa", keys: "inmersivo", shortcut: ["F"], when: hasDoc, run: toggleFocusMode },
    { icon: "▣", title: "Zoom automático (ancho cómodo)", keys: "zoom auto lectura", when: hasPdf, run: () => applyZoomMode("auto") },
    { icon: "▣", title: "Ajustar al ancho", keys: "zoom encajar", when: hasPdf, run: fitWidth },
    { icon: "▣", title: "Página completa", keys: "zoom encajar pagina entera fit", when: hasPdf, run: fitPage },
    { icon: "＋", title: "Acercar", keys: "zoom aumentar", shortcut: ["+"], when: hasDoc, run: () => changeReaderZoom(ZOOM_STEP) },
    { icon: "−", title: "Alejar", keys: "zoom reducir", shortcut: ["−"], when: hasDoc, run: () => changeReaderZoom(-ZOOM_STEP) },
    { icon: "↻", title: "Girar página", keys: "rotar", shortcut: ["R"], when: hasPdf, run: () => $("rotateBtn").click() },
    { icon: "▦", title: "Miniaturas de páginas", keys: "thumbnails vista previa", when: hasPdf, run: toggleThumbnails },
    { icon: "☰", title: "Mostrar u ocultar el panel lateral", keys: "indice sidebar contenido", when: hasDoc, run: toggleSidebar },
    { icon: "◇", title: "Marcar o desmarcar esta página", keys: "marcador bookmark", shortcut: ["B"], when: hasPdf, run: toggleBookmark },
    { icon: "✐", title: "Herramientas Ink (resaltar, subrayar, dibujar)", keys: "anotar marcador subrayado pluma", when: hasPdf && !reflowMode, run: () => $("markerModeBtn").click() },
    { icon: "✎", title: "Nota en un punto de la página", keys: "post-it adhesiva comentario pegar anclar", shortcut: ["N"], when: hasPdf && !reflowMode, run: () => setStickyPlacement(true) },
    { icon: "✎", title: "Nuevo apunte de esta página", keys: "nota escribir mano lapiz cuaderno", when: hasDoc, run: () => createPageNote() },
    { icon: "▥", title: $("notebookPanel").hidden ? "Abrir notas" : "Cerrar notas", keys: "apuntes cuaderno notas pagina resumen", shortcut: ["C"], when: hasDoc, run: toggleNotebook },
    { icon: "▥", title: "Nota del documento", keys: "resumen general apuntes", when: hasDoc, run: () => openNotebook("doc") },
    { icon: "▭", title: rulerOn ? "Quitar la regla de lectura" : "Regla de lectura (foco en una franja)", keys: "guia foco concentracion dislexia linea", shortcut: ["G"], when: hasDoc, run: () => setReadingRuler(!rulerOn) },
    { icon: "⇣", title: autoScroll.on ? "Detener el desplazamiento automático" : "Desplazamiento automático", keys: "autoscroll teleprompter scroll", shortcut: ["A"], when: hasDoc, run: () => setAutoScroll(!autoScroll.on) },
    { icon: "▧", title: "Guardar esta página como imagen (PNG)", keys: "exportar captura png descargar", when: hasPdf, run: exportPageImage },
    { icon: "⧉", title: "Copiar la imagen de esta página", keys: "portapapeles captura", when: hasPdf, run: copyPageImage },
    { icon: "¶", title: "Copiar el texto de esta página", keys: "portapapeles extraer", when: hasPdf, run: copyPageText },
    { icon: "↶", title: "Deshacer anotación", keys: "undo", shortcut: ["Ctrl", "Z"], when: hasDoc && annotationUndo.length > 0, run: undoAnnotation },
    { icon: "◆", title: "Estudiar: repasar tarjetas", keys: "flashcards repaso memoria examen tarjetas srs", shortcut: ["E"], when: hasDoc, run: () => openStudy() },
    { icon: "◆", title: "Nueva tarjeta de estudio", keys: "flashcard crear pregunta", when: hasDoc, run: () => renderStudyEditor() },
    { icon: "✦", title: "Generar tarjetas de esta página con IA", keys: "flashcards ia estudiar automatico", when: hasPdf, run: generateCardsWithAi },
    { icon: "✦", title: "Resumir esta página con IA", keys: "resumen sintesis puntos clave", when: hasDoc, run: () => runAiPreset("page", "Resume esta página en 5 puntos clave, citando [p. N].") },
    { icon: "✦", title: "Explicar la selección con IA", keys: "explicar simplificar entender", when: hasDoc, run: () => runAiPreset("selection", "Explícame este fragmento de forma sencilla, con un ejemplo.") },
    { icon: "✦", title: "Preguntar al documento (IA local)", keys: "asistente ia chat pregunta", when: hasDoc, run: openAssistantForDocument },
    { icon: "☀", title: "Tema claro", keys: "apariencia color", run: () => setTheme("light") },
    { icon: "☾", title: "Tema oscuro", keys: "apariencia noche", run: () => setTheme("dark") },
    { icon: "◐", title: "Tema sepia", keys: "apariencia papel", run: () => setTheme("sepia") },
    { icon: "↗", title: "Exportar anotaciones a Markdown", keys: "descargar notas md", when: hasDoc, run: exportMarkdown },
    { icon: "↓", title: "Exportar copia de las anotaciones (JSON)", keys: "descargar backup", when: hasDoc, run: exportAnnotations },
    { icon: "⌨", title: "Ver atajos de teclado", keys: "ayuda teclas", shortcut: ["?"], run: openShortcuts },
  ];
  return actions.filter((action) => action.when === undefined || action.when);
}
function ensurePaletteTextIndex() {
  if (!pdfDoc || !currentBook) return null;
  if (paletteTextIndex?.bookId === currentBook.id) return paletteTextIndex;
  const doc = pdfDoc;
  const index = { bookId: currentBook.id, pages: new Array(doc.numPages).fill(null), done: 0 };
  paletteTextIndex = index;
  (async () => {
    for (let i = 1; i <= doc.numPages; i++) {
      if (paletteTextIndex !== index || pdfDoc !== doc) return;
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        index.pages[i - 1] = content.items.map((item) => item.str).join(" ").replace(/\s+/g, " ");
      } catch {
        index.pages[i - 1] = "";
      }
      index.done = i;
      if (i % 12 === 0 || i === doc.numPages) schedulePaletteRender();
    }
  })();
  return index;
}
function paletteHighlight(text, regex) {
  if (!regex) return escapeHtml(text);
  const matcher = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let html = "",
    last = 0,
    match,
    guard = 0;
  while ((match = matcher.exec(text)) && guard++ < 20) {
    if (!match[0]) {
      matcher.lastIndex++;
      continue;
    }
    html += escapeHtml(text.slice(last, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}
function buildPaletteItems(query) {
  const raw = query.trim();
  const items = [];
  const push = (group, entries) => entries.forEach((entry) => items.push({ group, ...entry }));
  // 1) Número de página: "12", "p 12", "pág. 12"
  const pageMatch = raw.match(/^(?:p(?:[aá]g(?:ina)?)?\.?\s*)?(\d{1,5})$/i);
  if (pdfDoc && pageMatch) {
    const target = Math.max(1, Math.min(pdfDoc.numPages, Number(pageMatch[1])));
    push("Ir a", [{ icon: "#", title: `Ir a la página ${target}`, subtitle: `de ${pdfDoc.numPages}`, run: () => jumpToPage(target) }]);
  }
  // 2) Texto del documento
  if (pdfDoc && raw.length >= 2 && !pageMatch) {
    const index = ensurePaletteTextIndex();
    const regex = buildSearchRegex(raw);
    if (index && regex) {
      const hits = [];
      let total = 0;
      index.pages.forEach((text, i) => {
        if (!text) return;
        const found = collectPageMatches(text, regex, i + 1);
        total += found.length;
        found.slice(0, 2).forEach((hit, occurrence) => hits.push({ ...hit, occurrence }));
      });
      const pending = index.done < index.pages.length;
      const entries = hits.slice(0, 7).map((hit) => ({
        icon: "¶",
        title: `Página ${hit.page}`,
        subtitleHtml: paletteHighlight(hit.snippet, regex),
        meta: [`p. ${hit.page}`],
        run: () => applyPaletteSearch(raw, hit.page, hit.occurrence),
      }));
      if (total) {
        entries.push({
          icon: "⌕",
          title: total === 1 ? "Ver la coincidencia en el panel lateral" : `Ver las ${total} coincidencias en el panel lateral`,
          subtitle: pending ? `Indexando… ${index.done}/${index.pages.length} páginas` : "Navega entre ellas con ↑ ↓ o Enter en el buscador",
          run: () => applyPaletteSearch(raw),
        });
      } else if (pending) {
        entries.push({ icon: "…", title: "Buscando en el documento…", subtitle: `${index.done}/${index.pages.length} páginas indexadas`, run: () => applyPaletteSearch(raw) });
      }
      push("En este documento", entries);
    } else if (!regex && searchOptions.regex) {
      push("En este documento", [{ icon: "!", title: "Expresión regular no válida", subtitle: "Revisa el patrón o desactiva .*", run: () => {} }]);
    }
  }
  // 3) Secciones del índice
  const outline = outlineEntries();
  const outlineHits = outline
    .map((entry) => ({ entry, score: paletteScore(raw, entry.title) }))
    .filter((hit) => hit.score > (raw ? 11 : 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, raw ? 6 : 5)
    .map(({ entry }) => ({ icon: "§", title: entry.title, subtitle: entry.path || "", meta: [`p. ${entry.page}`], run: () => jumpToPage(entry.page) }));
  push("Índice", outlineHits);
  // 4) Acciones
  const actionHits = paletteActions()
    .map((action) => ({ action, score: paletteScore(raw, `${action.title} ${action.keys || ""}`) }))
    .filter((hit) => hit.score > (raw ? 11 : 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, raw ? 8 : 9)
    .map(({ action }) => ({ icon: action.icon, title: action.title, shortcut: action.shortcut, run: action.run }));
  push("Acciones", actionHits);
  // 5) Biblioteca
  const libraryHits = paletteLibrary
    .filter((record) => record.id !== currentBook?.id)
    .map((record) => ({ record, score: paletteScore(raw, record.name) }))
    .filter((hit) => hit.score > (raw ? 11 : 0))
    .sort((a, b) => b.score - a.score || (b.record.openedAt || 0) - (a.record.openedAt || 0))
    .slice(0, raw ? 5 : 4)
    .map(({ record }) => ({
      icon: record.kind === "markdown" ? "MD" : "PDF",
      title: record.name,
      subtitle: record.pages ? `${record.pages} páginas` : "Documento local",
      run: () => openStored(record.id),
    }));
  push(raw ? "Biblioteca" : "Recientes", libraryHits);
  return items;
}
function schedulePaletteRender() {
  if ($("palette").hidden || paletteRenderFrame) return;
  paletteRenderFrame = requestAnimationFrame(() => {
    paletteRenderFrame = 0;
    renderPalette(true);
  });
}
function renderPalette(keepSelection = false) {
  const list = $("paletteList");
  const previous = keepSelection ? paletteItems[paletteIndex]?.title : null;
  paletteItems = buildPaletteItems($("paletteInput").value);
  paletteIndex = previous ? Math.max(0, paletteItems.findIndex((item) => item.title === previous)) : 0;
  document.querySelectorAll("[data-palette-opt]").forEach((button) =>
    button.classList.toggle("active", Boolean(searchOptions[button.dataset.paletteOpt])),
  );
  const index = paletteTextIndex?.bookId === currentBook?.id ? paletteTextIndex : null;
  $("paletteStatus").textContent = index && index.done < index.pages.length ? `Indexando ${index.done}/${index.pages.length}` : "";
  if (!paletteItems.length) {
    list.innerHTML = `<div class="palette-empty">Sin resultados para «${escapeHtml($("paletteInput").value.trim())}».</div>`;
    return;
  }
  let html = "",
    group = "";
  paletteItems.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      html += `<div class="palette-group" role="presentation">${escapeHtml(group)}</div>`;
    }
    const meta = [
      ...(item.meta || []).map((value) => `<span>${escapeHtml(value)}</span>`),
      ...(item.shortcut || []).map((keyName) => `<kbd>${escapeHtml(keyName)}</kbd>`),
    ].join("");
    const subtitle = item.subtitleHtml || (item.subtitle ? escapeHtml(item.subtitle) : "");
    html += `<button class="palette-item" role="option" id="palette-opt-${i}" data-palette-index="${i}" aria-selected="${i === paletteIndex}"><span class="palette-item-icon">${escapeHtml(item.icon || "•")}</span><span class="palette-item-copy"><strong>${escapeHtml(item.title)}</strong>${subtitle ? `<small>${subtitle}</small>` : ""}</span>${meta ? `<span class="palette-item-meta">${meta}</span>` : ""}</button>`;
  });
  list.innerHTML = html;
  $("paletteInput").setAttribute("aria-activedescendant", `palette-opt-${paletteIndex}`);
}
function movePaletteSelection(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  $("paletteList")
    .querySelectorAll(".palette-item")
    .forEach((node) => node.setAttribute("aria-selected", String(Number(node.dataset.paletteIndex) === paletteIndex)));
  $(`palette-opt-${paletteIndex}`)?.scrollIntoView({ block: "nearest" });
  $("paletteInput").setAttribute("aria-activedescendant", `palette-opt-${paletteIndex}`);
}
function runPaletteItem(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette(false);
  Promise.resolve()
    .then(() => item.run())
    .catch((error) => console.error("La acción de la paleta falló", error));
}
async function openPalette(initial = "") {
  paletteReturnFocus = document.activeElement;
  $("palette").hidden = false;
  const input = $("paletteInput");
  input.value = initial;
  paletteIndex = 0;
  ensurePaletteTextIndex();
  renderPalette();
  input.focus();
  input.select();
  try {
    paletteLibrary = await dbAll();
    if (!$("palette").hidden) renderPalette(true);
  } catch {}
}
function closePalette(restoreFocus = true) {
  $("palette").hidden = true;
  if (restoreFocus && paletteReturnFocus?.focus) paletteReturnFocus.focus();
  paletteReturnFocus = null;
}
function togglePalette(initial = "") {
  if ($("palette").hidden) openPalette(initial);
  else closePalette();
}
// Lleva una búsqueda de la paleta al buscador principal (resultados en el panel
// lateral, resaltado en la página y navegación ↑/↓) usando el índice ya creado.
async function applyPaletteSearch(raw, page = 0, occurrence = 0) {
  const regex = buildSearchRegex(raw);
  if (!regex || !pdfDoc) return;
  $("searchInput").value = raw;
  searchScope = "document";
  document.querySelectorAll("[data-search-scope]").forEach((button) =>
    button.classList.toggle("active", button.dataset.searchScope === "document"),
  );
  const index = paletteTextIndex?.bookId === currentBook?.id ? paletteTextIndex : null;
  if (!index || index.done < index.pages.length) {
    await search(raw);
  } else {
    searchSignature = currentSearchSignature(raw);
    searchRawQuery = raw;
    searchQuery = raw.toLowerCase();
    searchRegex = regex;
    searchMatches = index.pages.flatMap((text, i) => (text ? collectPageMatches(text, regex, i + 1) : []));
    searchIndex = -1;
    if (!searchMatches.length) {
      renderSearchResults();
      toast("Sin coincidencias");
      return;
    }
    let target = page ? searchMatches.findIndex((match) => match.page === page) : searchMatches.findIndex((match) => match.page >= currentPage);
    if (target < 0) target = 0;
    target = Math.min(searchMatches.length - 1, target + (page ? occurrence : 0));
    await openSearchMatch(target);
    toast(`${searchMatches.length} coincidencia${searchMatches.length > 1 ? "s" : ""}`);
  }
  if (!isDrawerLayout() && document.body.classList.contains("sidebar-collapsed")) toggleSidebar();
  setSidebarPanel("contents");
}
// ---- Atajos de teclado ----
const SHORTCUT_GROUPS = [
  ["Navegación", [["Página siguiente / anterior", ["→", "←"]], ["Primera / última página", ["Inicio", "Fin"]], ["Vista anterior / siguiente", ["Alt", "←/→"]], ["Buscar o ir a…", ["Ctrl", "K"]], ["Buscar en el documento", ["Ctrl", "F"]], ["Coincidencia siguiente / anterior", ["Enter", "⇧ Enter"]]]],
  ["Lectura", [["Regla de lectura", ["G"]], ["Mover la regla", ["↑", "↓"]], ["Desplazamiento automático", ["A"]], ["Pausar / velocidad (auto-scroll)", ["Espacio", "[", "]"]], ["Modo enfoque", ["F"]], ["Presentación", ["P"]], ["Modo lectura adaptable", ["L"]], ["Acercar / alejar", ["+", "−"]], ["Girar página", ["R"]], ["Marcar página", ["B"]]]],
  ["Notas y anotaciones", [["Nota en un punto de la página", ["N"]], ["Ventana de notas", ["C"]], ["Editar anotaciones", ["S"]], ["Deshacer", ["Ctrl", "Z"]], ["Rehacer", ["Ctrl", "⇧", "Z"]]]],
  ["Estudio", [["Abrir tarjetas de estudio", ["E"]], ["Mostrar respuesta", ["Espacio"]], ["Calificar: otra vez · difícil · bien · fácil", ["1", "2", "3", "4"]]]],
  ["General", [["Atajos de teclado", ["?"]], ["Cerrar paneles", ["Esc"]]]],
];
function openShortcuts() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $("shortcutsGrid").innerHTML = SHORTCUT_GROUPS.map(
    ([title, rows]) =>
      `<section><h3>${title}</h3>${rows
        .map(([label, keys]) => `<div class="shortcut-row"><span>${label}</span><span>${keys.map((keyName) => `<kbd>${keyName === "Ctrl" && isMac ? "⌘" : keyName}</kbd>`).join("")}</span></div>`)
        .join("")}</section>`,
  ).join("");
  $("shortcutsPanel").hidden = false;
  $("closeShortcuts").focus();
}
function closeShortcuts() {
  $("shortcutsPanel").hidden = true;
}

// ---- Notas: apuntes de página y notas ancladas son la misma cosa ----
// Cada nota es una anotación de tipo "sticky": { page, note (texto), ink
// (escritura a mano), color, x/y }. Si tiene x/y está anclada a un punto de la
// página y se ve como un marcador numerado; si no, es un apunte de la página.
// Al ser anotaciones, el deshacer, la lista, los filtros, las exportaciones y
// el estudio las tratan igual que al resto.
const STICKY_COLORS = ["yellow", "green", "blue", "pink", "orange", "purple"];
const NOTE_INK_COLORS = { black: "#1f2328", blue: "#2f6fe0", red: "#d23c3c", green: "#23955a", purple: "#8047c9" };
const NOTE_HIGHLIGHT_COLORS = { yellow: "#ffd84a", green: "#86e39a", pink: "#ff9cc8", blue: "#99c8ff" };
const NOTE_INK_WIDTHS = { fine: 1.6, medium: 2.6, thick: 4.2 };
const NOTE_INK_REF_WIDTH = 320;
const NOTE_INK_DEFAULT_RATIO = 0.55;
let stickyPlacement = false;
let placementTargetId = null;
let activeStickyId = null;
let freshStickyId = null;
const freshNoteIds = new Set();
const noteTool = {
  mode: localStorage.getItem("paper.note-tool") || "text",
  ink: localStorage.getItem("paper.note-ink") || "black",
  highlight: localStorage.getItem("paper.note-highlight") || "yellow",
  width: localStorage.getItem("paper.note-width") || "medium",
};
function stickyColorValue(color) {
  return annotationStyle(color || "yellow", 0.95);
}
function isPinned(mark) {
  return Number.isFinite(mark?.x) && Number.isFinite(mark?.y);
}
function pageNoteMarks(page = currentPage) {
  return annotations()
    .filter((mark) => mark.type === "sticky" && mark.page === page)
    .sort((a, b) => a.createdAt - b.createdAt);
}
function pinNumber(mark) {
  return pageNoteMarks(mark.page).filter(isPinned).findIndex((item) => item.id === mark.id) + 1;
}
function noteHasContent(mark) {
  return Boolean(String(mark?.note || "").trim() || mark?.ink?.strokes?.length);
}
function renderStickyNotes() {
  const layer = $("stickyLayer");
  if (!layer) return;
  layer.replaceChildren();
  if (!currentBook || !pdfDoc || reflowMode) return;
  pageNoteMarks()
    .filter(isPinned)
    .forEach((mark, i) => {
      const pin = document.createElement("button");
      pin.className = "sticky-pin";
      pin.dataset.stickyId = mark.id;
      pin.style.left = `${mark.x * 100}%`;
      pin.style.top = `${mark.y * 100}%`;
      pin.style.setProperty("--sticky", stickyColorValue(mark.color));
      pin.classList.toggle("active", mark.id === activeStickyId);
      pin.textContent = String(i + 1);
      const preview = String(mark.note || "").trim() || (mark.ink?.strokes?.length ? "Nota escrita a mano" : "Nota vacía");
      pin.title = preview.slice(0, 180);
      pin.setAttribute("aria-label", `Nota ${i + 1}: ${preview.slice(0, 80)}`);
      layer.append(pin);
    });
}
// Modo de colocación: el siguiente toque en la página crea una nota anclada,
// o ancla la nota `targetId` si se indica.
function setStickyPlacement(on, targetId = null) {
  if (on) {
    if (!pdfDoc) return toast("Abre un PDF primero");
    if (reflowMode) return toast("Vuelve al PDF original para colocar notas en la página");
    if (viewMode === "continuous") setViewMode("single", { silent: true });
    if (markerMode) toggleMarkerMode();
    if (eraserMode) toggleEraserMode(false);
  }
  stickyPlacement = Boolean(on);
  placementTargetId = stickyPlacement ? targetId : null;
  document.body.classList.toggle("sticky-placing", stickyPlacement);
  $("stickyNoteBtn")?.setAttribute("aria-pressed", String(stickyPlacement));
  if (stickyPlacement) toast(targetId ? "Toca el punto de la página donde anclar la nota · Esc para cancelar" : "Toca la página donde quieras la nota · Esc para cancelar");
}
function newNoteMark(page, fields = {}) {
  return {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page,
    type: "sticky",
    color: localStorage.getItem("paper.sticky-color") || "yellow",
    x: null,
    y: null,
    note: "",
    text: "",
    rects: [],
    createdAt: Date.now(),
    ...fields,
  };
}
function createStickyAt(x, y) {
  if (!currentBook) return;
  const position = { x: Math.max(0.02, Math.min(0.98, x)), y: Math.max(0.02, Math.min(0.98, y)) };
  if (placementTargetId) {
    const id = placementTargetId;
    placementTargetId = null;
    updateAnnotation(id, { ...position, page: currentPage });
    openStickyEditor(id);
    return;
  }
  const mark = newNoteMark(currentPage, position);
  commitAnnotations([...annotations(), mark]);
  freshStickyId = mark.id;
  freshNoteIds.add(mark.id);
  renderAnnotations();
  renderAnnotationList();
  openStickyEditor(mark.id);
}
function createPageNote() {
  if (!currentBook) return toast("Abre un documento primero");
  const mark = newNoteMark(currentPage);
  commitAnnotations([...annotations(), mark]);
  freshNoteIds.add(mark.id);
  renderAnnotationList();
  openStickyEditor(mark.id);
}
// Las notas recién creadas que se abandonan vacías no dejan rastro.
function purgeEmptyFreshNotes() {
  if (!freshNoteIds.size || !currentBook) return;
  const items = annotations();
  // La nota activa se conserva sólo mientras sigas en su página.
  const kept = items.filter((mark) => !(freshNoteIds.has(mark.id) && !(mark.id === activeStickyId && mark.page === currentPage) && !noteHasContent(mark)));
  freshNoteIds.clear();
  freshStickyId = null;
  if (kept.length !== items.length) {
    commitAnnotations(kept, false);
    renderStickyNotes();
    renderAnnotationList();
  }
}
// Abrir una nota = mostrarla en la ventana de notas, lista para escribir.
async function openStickyEditor(id) {
  const mark = annotations().find((item) => item.id === id);
  if (!mark) return;
  if (mark.page !== currentPage && pdfDoc) await jumpToPage(mark.page);
  activeStickyId = id;
  notebookTab = "page";
  renderStickyNotes();
  openNotebook("page", { focusId: id });
}
function closeStickyEditor() {
  activeStickyId = null;
  renderStickyNotes();
  document.querySelectorAll(".nw-card.is-active").forEach((card) => card.classList.remove("is-active"));
}
function positionStickyEditor() {}
function bindStickyInteractions() {
  // Colocar una nota: se captura antes que la capa de texto para no iniciar
  // una selección ni alternar la interfaz inmersiva.
  $("canvasWrap").addEventListener(
    "pointerdown",
    (event) => {
      if (!stickyPlacement || event.button > 0) return;
      event.preventDefault();
      event.stopPropagation();
      const box = $("canvasWrap").getBoundingClientRect();
      const target = placementTargetId;
      setStickyPlacement(false);
      placementTargetId = target;
      createStickyAt((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    },
    true,
  );
  // Pulsar un marcador abre su nota; arrastrarlo lo recoloca.
  let drag = null;
  $("stickyLayer").addEventListener("pointerdown", (event) => {
    const pin = event.target.closest("[data-sticky-id]");
    if (!pin || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { pin, id: pin.dataset.stickyId, x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
    pin.setPointerCapture(event.pointerId);
  });
  $("stickyLayer").addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.moved = true;
    drag.pin.classList.add("dragging");
    const box = $("canvasWrap").getBoundingClientRect();
    drag.nx = Math.max(0.02, Math.min(0.98, (event.clientX - box.left) / box.width));
    drag.ny = Math.max(0.02, Math.min(0.98, (event.clientY - box.top) / box.height));
    drag.pin.style.left = `${drag.nx * 100}%`;
    drag.pin.style.top = `${drag.ny * 100}%`;
  });
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.pin.classList.remove("dragging");
    if (current.moved && current.nx !== undefined) updateAnnotation(current.id, { x: current.nx, y: current.ny });
    else if (event.type === "pointerup") openStickyEditor(current.id);
  };
  $("stickyLayer").addEventListener("pointerup", finish);
  $("stickyLayer").addEventListener("pointercancel", finish);
}

// ---- Escritura a mano en las notas ----
// Los trazos se guardan normalizados al ancho del lienzo (x/ancho, y/ancho),
// así se ven igual con la ventana estrecha o ancha. `h` es alto/ancho.
let lastPenInput = 0;
const noteInkUndo = [];
function inkCanvasSize(host) {
  const canvas = host.querySelector("canvas");
  const width = Math.max(120, host.clientWidth);
  const ratio = Number(host.dataset.ratio) || NOTE_INK_DEFAULT_RATIO;
  canvas.style.height = `${Math.round(width * ratio)}px`;
  return { canvas, width, height: Math.round(width * ratio) };
}
function drawInkStroke(ctx, stroke, width) {
  const points = stroke.p || [];
  if (!points.length) return;
  const scale = width / NOTE_INK_REF_WIDTH;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.c;
  ctx.fillStyle = stroke.c;
  const at = (point) => [point[0] * width, point[1] * width];
  if (stroke.t === "highlight") {
    // El marcador se pinta como un único trazo translúcido para que los
    // solapamientos internos no oscurezcan el color.
    ctx.globalAlpha = 0.42;
    ctx.globalCompositeOperation = "multiply";
    ctx.lineWidth = stroke.w * scale;
    ctx.beginPath();
    const [x0, y0] = at(points[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = at(points[i]);
      ctx.lineTo(x, y);
    }
    if (points.length === 1) ctx.lineTo(x0 + 0.1, y0);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const pressureWidth = (point) => stroke.w * scale * (point[2] ? 0.45 + point[2] * 1.1 : 1);
  if (points.length === 1) {
    const [x, y] = at(points[0]);
    ctx.beginPath();
    ctx.arc(x, y, pressureWidth(points[0]) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // Curvas cuadráticas entre puntos medios: trazo suave aunque lleguen pocos
  // eventos del puntero; el grosor sigue la presión del lápiz.
  let [prevX, prevY] = at(points[0]);
  for (let i = 1; i < points.length; i++) {
    const [cx, cy] = at(points[i - 1]);
    const [nx, ny] = at(points[i]);
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    ctx.beginPath();
    ctx.lineWidth = (pressureWidth(points[i - 1]) + pressureWidth(points[i])) / 2;
    ctx.moveTo(prevX, prevY);
    ctx.quadraticCurveTo(cx, cy, mx, my);
    ctx.stroke();
    prevX = mx;
    prevY = my;
  }
  const [lx, ly] = at(points[points.length - 1]);
  ctx.beginPath();
  ctx.moveTo(prevX, prevY);
  ctx.lineTo(lx, ly);
  ctx.stroke();
  ctx.restore();
}
function paintInkHost(host, ink, live = null) {
  const { canvas, width, height } = inkCanvasSize(host);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  for (const stroke of ink?.strokes || []) drawInkStroke(ctx, stroke, width);
  if (live) drawInkStroke(ctx, live, width);
  host.classList.toggle("is-empty", !(ink?.strokes?.length || live));
}
function inkTargetOf(host) {
  const [kind, id] = String(host.dataset.inkHost || "").split(":");
  return { kind, id };
}
function readTargetInk(target) {
  if (target.kind === "doc") return getJSON(key(currentBook.id, "doc-note-ink"), null) || { h: NOTE_INK_DEFAULT_RATIO, strokes: [] };
  const mark = annotations().find((item) => item.id === target.id);
  return mark?.ink ? structuredClone(mark.ink) : { h: NOTE_INK_DEFAULT_RATIO, strokes: [] };
}
function writeTargetInk(target, ink, record = true) {
  const previous = readTargetInk(target);
  if (record) {
    noteInkUndo.push({ target, ink: previous });
    if (noteInkUndo.length > 80) noteInkUndo.shift();
  }
  if (target.kind === "doc") setJSON(key(currentBook.id, "doc-note-ink"), ink);
  else {
    suppressNotebookRender = true;
    try {
      updateAnnotation(target.id, { ink }, false);
    } finally {
      suppressNotebookRender = false;
    }
  }
  $("notebookStatus").textContent = "Guardado";
  updateThumbNoteBadges();
}
function undoNoteInk() {
  const entry = noteInkUndo.pop();
  if (!entry) return toast("Nada que deshacer en la escritura a mano");
  writeTargetInk(entry.target, entry.ink, false);
  const host = document.querySelector(`[data-ink-host="${entry.target.kind}:${CSS.escape(entry.target.id)}"]`);
  if (host) {
    host.dataset.ratio = String(entry.ink.h || NOTE_INK_DEFAULT_RATIO);
    paintInkHost(host, entry.ink);
  }
}
function bindInkHost(host) {
  if (host.dataset.bound) return;
  host.dataset.bound = "1";
  const canvas = host.querySelector("canvas");
  let stroke = null;
  let ink = null;
  let erased = false;
  let frame = 0;
  const target = () => inkTargetOf(host);
  const pointFrom = (event, width) => {
    const box = canvas.getBoundingClientRect();
    const pressure = event.pointerType === "pen" && event.pressure > 0 ? Math.round(event.pressure * 100) / 100 : 0;
    return [Math.round(((event.clientX - box.left) / width) * 10000) / 10000, Math.round(((event.clientY - box.top) / width) * 10000) / 10000, pressure];
  };
  const repaint = () => {
    frame = 0;
    paintInkHost(host, ink, stroke);
  };
  const eraseAt = (point) => {
    const radius = 12 / NOTE_INK_REF_WIDTH;
    const before = ink.strokes.length;
    ink.strokes = ink.strokes.filter((item) => !item.p.some((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) < radius + (item.w / NOTE_INK_REF_WIDTH) / 2));
    if (ink.strokes.length !== before) erased = true;
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (noteTool.mode === "text" || event.button > 0) return;
    if (event.pointerType === "pen") lastPenInput = Date.now();
    // Mientras se usa lápiz, la palma de la mano no dibuja.
    else if (event.pointerType === "touch" && Date.now() - lastPenInput < 2000) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const { width } = inkCanvasSize(host);
    ink = readTargetInk(target());
    ink.h = Number(host.dataset.ratio) || ink.h || NOTE_INK_DEFAULT_RATIO;
    ink.strokes ||= [];
    const point = pointFrom(event, width);
    if (noteTool.mode === "eraser") {
      erased = false;
      host.dataset.snapshot = JSON.stringify(ink);
      eraseAt(point);
      stroke = null;
      repaint();
      return;
    }
    stroke = noteTool.mode === "highlight"
      ? { t: "highlight", c: NOTE_HIGHLIGHT_COLORS[noteTool.highlight] || NOTE_HIGHLIGHT_COLORS.yellow, w: NOTE_INK_WIDTHS[noteTool.width] * 5.5, p: [point] }
      : { t: "pen", c: NOTE_INK_COLORS[noteTool.ink] || NOTE_INK_COLORS.black, w: NOTE_INK_WIDTHS[noteTool.width], p: [point] };
    repaint();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!ink || !canvas.hasPointerCapture(event.pointerId)) return;
    const { width, height } = inkCanvasSize(host);
    const events = event.getCoalescedEvents?.() || [event];
    for (const item of events) {
      const point = pointFrom(item, width);
      if (noteTool.mode === "eraser") eraseAt(point);
      else if (stroke) {
        const last = stroke.p[stroke.p.length - 1];
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.002) stroke.p.push(point);
      }
    }
    // Al acercarse al borde inferior, el área de escritura crece sola.
    if (stroke && (event.clientY - canvas.getBoundingClientRect().top) > height - 28) {
      host.dataset.ratio = String(Math.min(6, (Number(host.dataset.ratio) || NOTE_INK_DEFAULT_RATIO) + 0.25));
      ink.h = Number(host.dataset.ratio);
    }
    if (!frame) frame = requestAnimationFrame(repaint);
  });
  const finish = (event) => {
    if (!ink || !canvas.hasPointerCapture(event.pointerId)) return;
    canvas.releasePointerCapture(event.pointerId);
    if (noteTool.mode === "eraser") {
      if (erased) {
        const after = ink;
        writeTargetInk(target(), JSON.parse(host.dataset.snapshot), false);
        writeTargetInk(target(), after);
      }
    } else if (stroke) {
      ink.strokes.push(stroke);
      writeTargetInk(target(), ink);
    }
    stroke = null;
    const final = ink;
    ink = null;
    paintInkHost(host, final);
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  host.querySelector("[data-ink-more]")?.addEventListener("click", () => {
    const next = readTargetInk(target());
    next.h = Math.min(6, (Number(host.dataset.ratio) || next.h || NOTE_INK_DEFAULT_RATIO) + 0.5);
    host.dataset.ratio = String(next.h);
    writeTargetInk(target(), next, false);
    paintInkHost(host, next);
  });
}

// ---- Regla de lectura ----
// Oscurece el visor salvo una franja horizontal que sigue al puntero; con ↑/↓
// avanza media franja y desplaza el documento cuando llega al borde.
const RULER_HEIGHTS = { small: 46, medium: 78, large: 124 };
let rulerOn = false;
let rulerRatio = 0.38;
let rulerFrame = 0;
function rulerHeight() {
  return RULER_HEIGHTS[localStorage.getItem("paper.ruler-size")] || RULER_HEIGHTS.medium;
}
function positionRuler() {
  rulerFrame = 0;
  const ruler = $("readingRuler");
  if (!rulerOn || ruler.hidden) return;
  const box = $("viewer").getBoundingClientRect();
  const height = rulerHeight();
  const top = Math.max(0, Math.min(box.height - height, rulerRatio * box.height - height / 2));
  ruler.style.left = `${box.left}px`;
  ruler.style.top = `${box.top}px`;
  ruler.style.width = `${box.width}px`;
  ruler.style.height = `${box.height}px`;
  ruler.style.setProperty("--ruler-top", `${top}px`);
  ruler.style.setProperty("--ruler-h", `${height}px`);
}
function scheduleRuler() {
  if (rulerOn && !rulerFrame) rulerFrame = requestAnimationFrame(positionRuler);
}
function setReadingRuler(on, quiet = false) {
  if (on && !currentBook) return quiet ? undefined : toast("Abre un documento primero");
  rulerOn = Boolean(on);
  $("readingRuler").hidden = !rulerOn;
  $("rulerBtn")?.setAttribute("aria-pressed", String(rulerOn));
  localStorage.setItem("paper.ruler", rulerOn ? "1" : "0");
  if (rulerOn) {
    positionRuler();
    if (!quiet) toast("Regla de lectura: mueve el puntero o usa ↑ ↓");
  }
}
function moveRulerBy(direction) {
  const viewer = $("viewer");
  const box = viewer.getBoundingClientRect();
  const step = rulerHeight() * 0.5;
  const next = rulerRatio * box.height + direction * step;
  const margin = rulerHeight();
  // Cerca de los bordes se desplaza el documento y la franja se queda quieta.
  if ((direction > 0 && next > box.height - margin) || (direction < 0 && next < margin)) {
    const before = viewer.scrollTop;
    viewer.scrollBy({ top: direction * step, behavior: "auto" });
    if (viewer.scrollTop === before && pdfDoc && viewMode !== "continuous") {
      if (direction > 0 && currentPage < pdfDoc.numPages) {
        rulerRatio = 0.2;
        renderPage(currentPage + 1);
      } else if (direction < 0 && currentPage > 1) {
        rulerRatio = 0.8;
        renderPage(currentPage - 1, { resetScroll: false }).then(() => (viewer.scrollTop = viewer.scrollHeight));
      }
    }
  } else {
    rulerRatio = Math.max(0.05, Math.min(0.95, next / box.height));
  }
  scheduleRuler();
}
function setRulerSize(size) {
  localStorage.setItem("paper.ruler-size", size);
  document.querySelectorAll("[data-ruler-size]").forEach((button) => button.classList.toggle("active", button.dataset.rulerSize === size));
  scheduleRuler();
}

// ---- Desplazamiento automático ----
const AUTOSCROLL_SPEEDS = [14, 20, 28, 38, 52, 70, 94, 125, 165, 220];
const autoScroll = { on: false, paused: false, level: 3, last: 0, carry: 0, raf: 0, holdUntil: 0, turning: false };
function updateAutoScrollUi() {
  $("autoScrollBar").hidden = !autoScroll.on;
  $("autoScrollBtn")?.setAttribute("aria-pressed", String(autoScroll.on));
  $("autoScrollToggle").textContent = autoScroll.paused ? "▶" : "⏸";
  $("autoScrollSpeed").textContent = `Velocidad ${autoScroll.level + 1}`;
}
function autoScrollTick(time) {
  if (!autoScroll.on) return;
  const dt = autoScroll.last ? (time - autoScroll.last) / 1000 : 0;
  autoScroll.last = time;
  if (!autoScroll.paused && !autoScroll.turning && dt > 0 && dt < 0.25 && performance.now() > autoScroll.holdUntil) {
    const viewer = $("viewer");
    autoScroll.carry += AUTOSCROLL_SPEEDS[autoScroll.level] * dt;
    const step = Math.floor(autoScroll.carry);
    if (step >= 1) {
      autoScroll.carry -= step;
      const before = viewer.scrollTop;
      viewer.scrollTop = before + step;
      if (Math.abs(viewer.scrollTop - before) < 0.5) autoScrollReachedEnd();
    }
  }
  autoScroll.raf = requestAnimationFrame(autoScrollTick);
}
async function autoScrollReachedEnd() {
  const canTurn = pdfDoc && viewMode !== "continuous" && currentPage < pdfDoc.numPages;
  if (!canTurn) {
    setAutoScroll(false);
    toast("Fin del documento");
    return;
  }
  autoScroll.turning = true;
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (autoScroll.on) await renderPage(currentPage + (viewMode === "double" ? 2 : 1));
  autoScroll.holdUntil = performance.now() + 900;
  autoScroll.turning = false;
}
function setAutoScroll(on) {
  if (on && !currentBook) return toast("Abre un documento primero");
  autoScroll.on = Boolean(on);
  autoScroll.paused = false;
  autoScroll.last = 0;
  autoScroll.carry = 0;
  cancelAnimationFrame(autoScroll.raf);
  if (autoScroll.on) {
    autoScroll.level = Math.max(0, Math.min(AUTOSCROLL_SPEEDS.length - 1, Number(localStorage.getItem("paper.autoscroll-level") ?? 3)));
    autoScroll.raf = requestAnimationFrame(autoScrollTick);
    toast("Auto-scroll: espacio pausa · [ ] velocidad");
  }
  updateAutoScrollUi();
}
function changeAutoScrollSpeed(delta) {
  autoScroll.level = Math.max(0, Math.min(AUTOSCROLL_SPEEDS.length - 1, autoScroll.level + delta));
  localStorage.setItem("paper.autoscroll-level", String(autoScroll.level));
  updateAutoScrollUi();
}
function toggleAutoScrollPause() {
  autoScroll.paused = !autoScroll.paused;
  autoScroll.last = 0;
  updateAutoScrollUi();
}

// ---- Exportar y copiar la página actual ----
async function renderPageToCanvas(pageNumber, targetWidth = 2000) {
  const page = await getCachedPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: Math.min(4, Math.max(1, targetWidth / base.width)), rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}
async function exportPageImage() {
  if (!pdfDoc || !currentBook) return toast("Abre un PDF primero");
  try {
    const canvas = await renderPageToCanvas(currentPage);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentBook.name.replace(/\.pdf$/i, "")}-p${currentPage}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Página ${currentPage} guardada como imagen`);
  } catch (error) {
    console.error(error);
    toast("No se pudo exportar la página");
  }
}
async function copyPageImage() {
  if (!pdfDoc) return toast("Abre un PDF primero");
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("sin soporte");
    const canvas = await renderPageToCanvas(currentPage, 1600);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Imagen de la página copiada");
  } catch {
    toast("Este navegador no permite copiar imágenes; usa «Guardar PNG»");
  }
}
async function copyPageText() {
  if (!pdfDoc) return toast("Abre un PDF primero");
  try {
    const text = await getPagePlainText(currentPage);
    if (!text.trim()) return toast("Esta página no tiene texto extraíble");
    await navigator.clipboard.writeText(text);
    toast(`Texto de la página ${currentPage} copiado`);
  } catch {
    toast("No se pudo copiar el texto");
  }
}
function updateRemainingTime() {
  const label = $("pageRemaining");
  if (!label) return;
  if (!currentBook || !pdfDoc) {
    label.hidden = true;
    return;
  }
  const estimate = readingEstimate({ ...currentBook, pages: pdfDoc.numPages });
  label.hidden = estimate.remainingMs < 60_000;
  label.textContent = `· ${formatReadingDuration(estimate.remainingMs, true)} restantes`;
  label.title = "Estimación según tu ritmo de lectura en este documento";
}
function bindReadingTools() {
  $("viewer").addEventListener("pointermove", (event) => {
    if (!rulerOn || event.pointerType === "touch") return;
    const box = $("viewer").getBoundingClientRect();
    rulerRatio = Math.max(0.02, Math.min(0.98, (event.clientY - box.top) / box.height));
    scheduleRuler();
  }, { passive: true });
  window.addEventListener("resize", scheduleRuler, { passive: true });
  $("rulerBtn").onclick = () => setReadingRuler(!rulerOn);
  document.querySelectorAll("[data-ruler-size]").forEach((button) => (button.onclick = () => setRulerSize(button.dataset.rulerSize)));
  setRulerSize(localStorage.getItem("paper.ruler-size") || "medium");
  $("autoScrollBtn").onclick = () => setAutoScroll(!autoScroll.on);
  $("autoScrollToggle").onclick = toggleAutoScrollPause;
  $("autoScrollSlower").onclick = () => changeAutoScrollSpeed(-1);
  $("autoScrollFaster").onclick = () => changeAutoScrollSpeed(1);
  $("autoScrollClose").onclick = () => setAutoScroll(false);
  // El desplazamiento manual tiene prioridad durante un momento.
  for (const type of ["wheel", "touchstart"]) {
    $("viewer").addEventListener(type, () => {
      if (autoScroll.on) autoScroll.holdUntil = performance.now() + 1500;
    }, { passive: true });
  }
  $("exportPageImageBtn").onclick = exportPageImage;
  $("copyPageTextBtn").onclick = copyPageText;
}

// ---- Interfaz v4: iconos, menú de zoom y estado de los controles ----
// Iconos de trazo (estilo Lucide) para que toda la interfaz hable el mismo
// lenguaje visual en lugar de mezclar caracteres Unicode sueltos.
const ICONS = {
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  library: '<path d="M4 4.5v15"/><path d="M8 6.5v13"/><path d="M12 6.5v13"/><path d="m15.5 6.8 4.3 12.6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  forward: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  sparkles: '<path d="M11 3.5 12.7 8a2 2 0 0 0 1.3 1.3l4.5 1.7-4.5 1.7a2 2 0 0 0-1.3 1.3L11 18.5 9.3 14a2 2 0 0 0-1.3-1.3L3.5 11 8 9.3A2 2 0 0 0 9.3 8z"/><path d="M19 3v4M17 5h4"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  sticky: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>',
  notebook: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M2 7h4M2 12h4M2 17h4M9.5 7.5h6M9.5 11.5h6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9.5 9.5 0 0 1 0 13"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  rotate: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5"/><path d="M20.5 3.5v5h-5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fitWidth: '<path d="M3 5v14M21 5v14"/><path d="m7 12 3-3M7 12l3 3M7 12h10m0 0-3-3m3 3-3 3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  pinOff: '<path d="M12 17v5"/><path d="M15 9.3V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.9"/><path d="m2 2 20 20"/><path d="M9 9v1.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h11"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  type: '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>',
  pen: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  cursor: '<path d="M4.5 3.5 11 20l2.4-6.6L20 11z"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/>',
  wavy: '<path d="M7 4v5a5 5 0 0 0 10 0V4"/><path d="M3 19c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.8 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.3"/><circle cx="17.5" cy="10.5" r="1.3"/><circle cx="8.5" cy="7.5" r="1.3"/><circle cx="6.5" cy="12.5" r="1.3"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6"/>',
};
function iconSvg(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
function setIcon(target, name, label = "") {
  const element = typeof target === "string" ? $(target) : target;
  if (!element) return;
  element.innerHTML = iconSvg(name) + (label ? `<span class="btn-label">${escapeHtml(label)}</span>` : "");
  element.classList.add("has-icon");
}
function applyInterfaceIcons() {
  const icons = {
    openSidebar: "panelLeft", homeBtn: "library", closeSidebar: "panelLeft",
    navBack: "back", navForward: "forward", toolbarPrev: "chevronLeft", toolbarNext: "chevronRight",
    prevBtn: "chevronLeft", nextBtn: "chevronRight", stickyNoteBtn: "sticky", notebookBtn: "notebook",
    readAloudBtn: "volume", bookmarkBtn: "bookmark", thumbBtn: "grid", rotateBtn: "rotate",
    zoomOut: "minus", zoomIn: "plus", toolbarFitBtn: "fitWidth",
  };
  for (const [id, name] of Object.entries(icons)) setIcon(id, name);
  setAssistantButton($("captureBtn").classList.contains("assistant-on"));
  setIcon("markerModeBtn", "highlighter", "Ink");
  setIcon("appearanceBtn", "sliders", "Vista");
  const trigger = document.querySelector(".palette-trigger-icon");
  if (trigger) trigger.innerHTML = iconSvg("search");
  $("homeBtn").title = "Biblioteca";
  $("closeSidebar").title = "Ocultar panel lateral";
}
function updateBookmarkButton() {
  const button = $("bookmarkBtn");
  if (!button) return;
  const marked = Boolean(currentBook && getJSON(key(currentBook.id, "bookmarks"), []).includes(currentPage));
  button.setAttribute("aria-pressed", String(marked));
  button.title = marked ? `Quitar marcador de la página ${currentPage} (B)` : `Marcar la página ${currentPage} (B)`;
  button.setAttribute("aria-label", button.title);
}
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300];
function renderZoomMenu() {
  const menu = $("zoomMenu");
  const percent = Math.round(scale * 100);
  const modes = [
    ["auto", "Automático", "Ancho cómodo para leer"],
    ["width", "Ajustar al ancho", "Llena el ancho disponible"],
    ["page", "Página completa", "La página entera a la vista"],
  ];
  menu.innerHTML =
    modes.map(([mode, label, hint]) => `<button role="menuitemradio" aria-checked="${zoomMode === mode}" data-zoom-mode="${mode}"><span class="zoom-check">${zoomMode === mode ? iconSvg("check") : ""}</span><span><strong>${label}</strong><small>${hint}</small></span></button>`).join("") +
    '<hr>' +
    `<div class="zoom-presets">${ZOOM_PRESETS.map((value) => `<button role="menuitemradio" aria-checked="${zoomMode === "custom" && value === percent}" data-zoom-percent="${value}">${value}%</button>`).join("")}</div>`;
}
function closeZoomMenu() {
  const menu = $("zoomMenu");
  if (menu) menu.hidden = true;
  $("zoomLabel")?.setAttribute("aria-expanded", "false");
}
function toggleZoomMenu(event) {
  event?.stopPropagation();
  const menu = $("zoomMenu");
  if (!pdfDoc) return;
  if (reflowMode) return toast("En modo lectura, usa A− / A+ para el tamaño del texto");
  if (!menu.hidden) return closeZoomMenu();
  renderZoomMenu();
  menu.hidden = false;
  $("zoomLabel").setAttribute("aria-expanded", "true");
  const anchor = $("zoomLabel").getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left + anchor.width / 2 - width / 2))}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - anchor.top + 10)}px`;
}
function bindInterfaceV4() {
  const menu = document.createElement("div");
  menu.id = "zoomMenu";
  menu.className = "zoom-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Zoom");
  document.body.append(menu);
  $("zoomLabel").setAttribute("aria-haspopup", "menu");
  $("zoomLabel").setAttribute("aria-expanded", "false");
  menu.addEventListener("click", (event) => {
    const mode = event.target.closest("[data-zoom-mode]")?.dataset.zoomMode;
    const percent = event.target.closest("[data-zoom-percent]")?.dataset.zoomPercent;
    if (mode) applyZoomMode(mode);
    else if (percent) setZoom(Number(percent) / 100);
    else return;
    closeZoomMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !event.target.closest("#zoomMenu, #zoomLabel")) closeZoomMenu();
  });
  window.addEventListener("resize", closeZoomMenu, { passive: true });
}
// ---- Ventana de notas ----
let notebookTab = "page";
let notebookShownPage = 0;
let suppressNotebookRender = false;
const noteTextTimers = new Map();
// Almacén antiguo de apuntes por página: sólo se lee para migrarlo.
function pageNotesStore() {
  return currentBook ? getJSON(key(currentBook.id, "page-notes"), {}) : {};
}
function documentNote() {
  return currentBook ? localStorage.getItem(key(currentBook.id, "doc-note")) || "" : "";
}
function writeDocumentNote(text) {
  if (!currentBook) return;
  if (text.trim()) localStorage.setItem(key(currentBook.id, "doc-note"), text.slice(0, 40000));
  else localStorage.removeItem(key(currentBook.id, "doc-note"));
}
function documentNoteInk() {
  return currentBook ? getJSON(key(currentBook.id, "doc-note-ink"), null) : null;
}
function wordCount(text) {
  return (String(text).trim().match(/\S+/g) || []).length;
}
// Convierte los apuntes por página de versiones anteriores en notas.
function migrateLegacyPageNotes() {
  if (!currentBook) return 0;
  const store = pageNotesStore();
  const entries = Object.entries(store).filter(([, entry]) => String(entry?.text || "").trim());
  if (!entries.length) {
    if (Object.keys(store).length) localStorage.removeItem(key(currentBook.id, "page-notes"));
    return 0;
  }
  const migrated = entries.map(([page, entry]) =>
    newNoteMark(Number(page), { note: String(entry.text).slice(0, 20000), createdAt: Number(entry.updatedAt) || Date.now() }),
  );
  commitAnnotations([...annotations(), ...migrated], false);
  localStorage.removeItem(key(currentBook.id, "page-notes"));
  return migrated.length;
}
function flushNotebook() {
  for (const [id, timer] of noteTextTimers) {
    clearTimeout(timer);
    saveNoteText(id);
  }
  noteTextTimers.clear();
}
function saveNoteText(id) {
  noteTextTimers.delete(id);
  const field = document.querySelector(`[data-note-text="${CSS.escape(id)}"]`);
  if (!field || !currentBook) return;
  if (id === "doc") writeDocumentNote(field.value);
  else {
    suppressNotebookRender = true;
    try {
      updateAnnotation(id, { note: field.value.slice(0, 20000) }, false);
    } finally {
      suppressNotebookRender = false;
    }
    renderStickyNotes();
  }
  $("notebookStatus").textContent = "Guardado";
  updateThumbNoteBadges();
}
function scheduleNoteText(id) {
  $("notebookStatus").textContent = "Guardando…";
  clearTimeout(noteTextTimers.get(id));
  noteTextTimers.set(id, setTimeout(() => saveNoteText(id), 400));
}
function noteCardHtml(mark, kind = "note") {
  const id = kind === "doc" ? "doc" : mark.id;
  const text = kind === "doc" ? documentNote() : mark.note || "";
  const ink = kind === "doc" ? documentNoteInk() : mark.ink;
  const pinned = kind !== "doc" && isPinned(mark);
  const date = kind !== "doc" && mark.createdAt ? new Date(mark.updatedAt || mark.createdAt).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "";
  const chip = kind === "doc" ? "Nota del documento" : pinned ? `<b>${pinNumber(mark)}</b> En la página` : "Apunte";
  const actions = kind === "doc"
    ? ""
    : `<button class="note-act" data-note-color="${id}" title="Cambiar color" aria-label="Cambiar color"><i style="--swatch:${stickyColorValue(mark.color)}"></i></button><button class="note-act" data-note-pin="${id}" title="${pinned ? "Quitar de la página" : "Anclar en un punto de la página"}" aria-label="${pinned ? "Quitar de la página" : "Anclar en la página"}">${iconSvg(pinned ? "pinOff" : "pin")}</button><button class="note-act danger" data-note-delete="${id}" title="Eliminar nota" aria-label="Eliminar nota">${iconSvg("trash")}</button>`;
  return `<article class="nw-card${activeStickyId === id ? " is-active" : ""}" data-note="${escapeHtml(id)}" style="--note:${kind === "doc" ? "var(--accent)" : stickyColorValue(mark.color)}"><header><span class="note-chip">${chip}</span><span class="note-date">${date}</span><span class="note-actions">${actions}</span></header><textarea class="note-text" data-note-text="${escapeHtml(id)}" rows="${Math.min(14, Math.max(2, text.split("\n").length + 1))}" placeholder="${kind === "doc" ? "Resumen, tesis, preguntas abiertas del documento…" : "Escribe tu nota…"}" aria-label="Texto de la nota">${escapeHtml(text)}</textarea><div class="note-ink${ink?.strokes?.length ? "" : " is-empty"}" data-ink-host="${kind === "doc" ? "doc" : "note"}:${escapeHtml(id)}" data-ratio="${ink?.h || NOTE_INK_DEFAULT_RATIO}"><canvas aria-label="Escritura a mano"></canvas><span class="note-ink-hint">Escribe o dibuja aquí</span><button class="note-ink-more" data-ink-more title="Más espacio para escribir">＋</button></div></article>`;
}
function renderNotesTools() {
  const tools = $("notesTools");
  const mode = noteTool.mode;
  const palette = mode === "highlight" ? NOTE_HIGHLIGHT_COLORS : NOTE_INK_COLORS;
  const current = mode === "highlight" ? noteTool.highlight : noteTool.ink;
  const modes = [["text", "type", "Escribir texto"], ["pen", "pen", "Pluma"], ["highlight", "highlighter", "Marcador"], ["eraser", "eraser", "Goma"]];
  tools.innerHTML = `<div class="nw-seg" role="radiogroup" aria-label="Herramienta">${modes.map(([value, icon, label]) => `<button role="radio" aria-checked="${mode === value}" data-note-mode="${value}" title="${label}" aria-label="${label}">${iconSvg(icon)}</button>`).join("")}</div>${mode === "pen" || mode === "highlight"
    ? `<div class="nw-swatches" role="radiogroup" aria-label="Color">${Object.entries(palette).map(([name, value]) => `<button role="radio" aria-checked="${current === name}" data-note-ink="${name}" style="--swatch:${value}" aria-label="Color ${name}"></button>`).join("")}</div><div class="nw-widths" role="radiogroup" aria-label="Grosor">${Object.keys(NOTE_INK_WIDTHS).map((name, i) => `<button role="radio" aria-checked="${noteTool.width === name}" data-note-width="${name}" aria-label="Grosor ${name}"><i style="--dot:${4 + i * 3}px"></i></button>`).join("")}</div>`
    : `<span class="nw-hint">${mode === "eraser" ? "Toca un trazo para borrarlo" : "Escribe con el teclado o elige la pluma para escribir a mano"}</span>`}<button class="nw-undo" data-note-undo title="Deshacer trazo" aria-label="Deshacer trazo">${iconSvg("back")}</button>`;
  $("notebookPanel").dataset.mode = mode;
}
function renderNotebook(options = {}) {
  if (!currentBook) return;
  const body = $("notesBody");
  const scroll = body.scrollTop;
  flushNotebook();
  if (notebookShownPage && notebookShownPage !== currentPage) purgeEmptyFreshNotes();
  notebookShownPage = currentPage;
  const pageLabel = pdfDoc ? `Página ${currentPage}` : "Documento";
  $("notebookTitle").textContent = notebookTab === "doc" ? "Nota del documento" : notebookTab === "all" ? "Todas las notas" : pageLabel;
  document.querySelectorAll("[data-notebook-tab]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.notebookTab === notebookTab)));
  renderNotesTools();
  const all = annotations().filter((mark) => mark.type === "sticky");
  if (notebookTab === "page") {
    const marks = pageNoteMarks();
    body.innerHTML = marks.length
      ? marks.map((mark) => noteCardHtml(mark)).join("")
      : `<div class="nw-empty"><strong>Sin notas en esta página</strong><p>Escribe un apunte o pega una nota en un punto concreto de la página. Puedes escribir con el teclado o a mano.</p><div><button class="btn" data-empty-new>${iconSvg("plus")} Nuevo apunte</button><button class="btn" data-empty-pin>${iconSvg("pin")} Nota en la página</button></div></div>`;
  } else if (notebookTab === "doc") {
    body.innerHTML = noteCardHtml(null, "doc");
  } else {
    const pages = new Map();
    for (const mark of all) {
      const entry = pages.get(mark.page) || { count: 0, preview: "", ink: false };
      entry.count++;
      if (!entry.preview && mark.note?.trim()) entry.preview = mark.note.trim();
      if (mark.ink?.strokes?.length) entry.ink = true;
      pages.set(mark.page, entry);
    }
    const docText = documentNote().trim();
    const docInk = Boolean(documentNoteInk()?.strokes?.length);
    const rows = [...pages.entries()].sort((a, b) => a[0] - b[0]);
    body.innerHTML =
      (docText || docInk ? `<button class="nw-entry" data-notebook-doc><strong>Nota del documento<span>${docInk ? "✎ " : ""}${wordCount(docText)} palabras</span></strong><small>${escapeHtml(docText || "Escrita a mano")}</small></button>` : "") +
      (rows.length
        ? rows.map(([page, entry]) => `<button class="nw-entry" data-notebook-page="${page}"><strong>Página ${page}<span>${entry.ink ? "✎ " : ""}${entry.count} nota${entry.count > 1 ? "s" : ""}</span></strong><small>${escapeHtml(entry.preview || "Escrita a mano")}</small></button>`).join("")
        : docText || docInk ? "" : '<div class="nw-empty"><strong>Aún no hay notas</strong><p>Pulsa <b>N</b> para pegar una nota en la página o escribe un apunte en «Esta página».</p></div>');
  }
  body.querySelectorAll("[data-ink-host]").forEach((host) => {
    bindInkHost(host);
    const ink = inkTargetOf(host).kind === "doc" ? documentNoteInk() : annotations().find((mark) => mark.id === inkTargetOf(host).id)?.ink;
    paintInkHost(host, ink);
  });
  body.scrollTop = options.keepScroll === false ? 0 : scroll;
  const status = $("notebookStatus");
  if (!noteTextTimers.size) status.textContent = notebookTab === "all" ? `${all.length} nota${all.length === 1 ? "" : "s"}` : "Se guarda automáticamente";
  if (options.focusId) {
    const card = body.querySelector(`[data-note="${CSS.escape(options.focusId)}"]`);
    if (card) {
      body.querySelectorAll(".nw-card.is-active").forEach((item) => item.classList.remove("is-active"));
      card.classList.add("is-active");
      card.scrollIntoView({ block: "nearest" });
      if (noteTool.mode === "text") {
        const field = card.querySelector("textarea");
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
  }
}
function syncNotebookPage() {
  if ($("notebookPanel").hidden || notebookShownPage === currentPage) return;
  if (notebookTab === "page") renderNotebook({ keepScroll: false });
  else notebookShownPage = currentPage;
}
function setNoteTool(patch) {
  Object.assign(noteTool, patch);
  localStorage.setItem("paper.note-tool", noteTool.mode);
  localStorage.setItem("paper.note-ink", noteTool.ink);
  localStorage.setItem("paper.note-highlight", noteTool.highlight);
  localStorage.setItem("paper.note-width", noteTool.width);
  renderNotesTools();
}
// Posición y tamaño de la ventana, como la del asistente.
function applyNotesWindowGeometry() {
  const panel = $("notebookPanel");
  if (window.innerWidth <= 700) {
    panel.style.cssText = "";
    return;
  }
  const saved = getJSON("paper.notes-window", null);
  const topbar = 56;
  const width = Math.min(window.innerWidth - 24, Math.max(300, saved?.width || 380));
  const height = Math.min(window.innerHeight - topbar - 24, Math.max(260, saved?.height || Math.min(660, window.innerHeight - topbar - 110)));
  const left = Number.isFinite(saved?.left) ? saved.left : window.innerWidth - width - 16;
  const top = Number.isFinite(saved?.top) ? saved.top : topbar + 12;
  panel.style.width = `${width}px`;
  panel.style.height = panel.classList.contains("is-minimized") ? "" : `${height}px`;
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - Math.min(width, 200) - 8, left))}px`;
  panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 52, top))}px`;
}
function saveNotesWindowGeometry() {
  const panel = $("notebookPanel");
  if (window.innerWidth <= 700 || panel.hidden) return;
  const box = panel.getBoundingClientRect();
  const saved = getJSON("paper.notes-window", {});
  setJSON("paper.notes-window", {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: panel.classList.contains("is-minimized") ? saved.height : Math.round(box.height),
  });
}
function setNotesMinimized(minimized) {
  const panel = $("notebookPanel");
  panel.classList.toggle("is-minimized", minimized);
  setIcon("notesMinimize", minimized ? "chevronUp" : "minus");
  $("notesMinimize").title = minimized ? "Restaurar" : "Minimizar";
  localStorage.setItem("paper.notes-minimized", minimized ? "1" : "0");
  applyNotesWindowGeometry();
}
function openNotebook(tab, options = {}) {
  if (!currentBook) return toast("Abre un documento primero");
  if (typeof tab === "string") notebookTab = tab;
  const panel = $("notebookPanel");
  const wasHidden = panel.hidden;
  panel.hidden = false;
  document.body.classList.add("notebook-open");
  $("notebookBtn")?.setAttribute("aria-pressed", "true");
  if (panel.classList.contains("is-minimized") && options.focusId) setNotesMinimized(false);
  if (wasHidden) applyNotesWindowGeometry();
  renderNotebook({ focusId: options.focusId, keepScroll: !wasHidden });
}
function closeNotebook() {
  flushNotebook();
  purgeEmptyFreshNotes();
  $("notebookPanel").hidden = true;
  document.body.classList.remove("notebook-open");
  $("notebookBtn")?.setAttribute("aria-pressed", "false");
  closeStickyEditor();
}
function toggleNotebook() {
  $("notebookPanel").hidden ? openNotebook() : closeNotebook();
}
function updateThumbNoteBadges() {
  if (!currentBook) return;
  const pages = new Set(Object.keys(pageNotesStore()).map(Number));
  annotations().forEach((mark) => {
    if (mark.type === "sticky") pages.add(mark.page);
  });
  document.querySelectorAll(".thumb[data-page]").forEach((card) => card.classList.toggle("has-notes", pages.has(Number(card.dataset.page))));
}

// ---- Estudio: tarjetas con repaso espaciado (SM-2) ----
// Las tarjetas se guardan por documento. Pueden venir de resaltados (ejercicio
// de huecos), de notas «pregunta :: respuesta» (también líneas del cuaderno),
// de una selección, de la IA local o crearse a mano.
const DAY_MS = 86_400_000;
const CLOZE_STOP_WORDS = new Set("además ahora antes aquel aquella aunque cada cierto como cómo desde después donde durante ejemplo entonces entre esta estas este esto estos hasta hacia incluso luego mientras mismo mucho muchos nada nosotros nuestra nuestro otras otros parte porque puede pueden según siempre sobre también tanto tiene tienen todas todos través usted veces vuestra where which would their there these those about because through between before after other which while".split(" "));
let studyQueue = [];
let studyIndex = 0;
let studyRevealed = false;
let studyReviewed = 0;
function studyCards() {
  return currentBook ? getJSON(key(currentBook.id, "cards"), []) : [];
}
function saveStudyCards(cards) {
  if (currentBook) setJSON(key(currentBook.id, "cards"), cards);
  updateStudyLaunch();
}
function newCard(front, back, source = {}) {
  return {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    front: String(front).trim().slice(0, 1200),
    back: String(back).trim().slice(0, 3000),
    page: Number(source.page) || currentPage || 1,
    sourceKey: source.sourceKey || "",
    origin: source.origin || "manual",
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: Date.now(),
    createdAt: Date.now(),
  };
}
function hashText(text) {
  let hash = 0;
  for (const char of String(text)) hash = (Math.imul(31, hash) + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
// Oculta las palabras más significativas de un fragmento (las más largas que
// no son palabras vacías) para practicar el recuerdo activo.
function makeCloze(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const words = [...new Set(clean.match(/[\p{L}][\p{L}\p{N}-]{5,}/gu) || [])].filter(
    (word) => !CLOZE_STOP_WORDS.has(normalizeText(word)) && !AI_STOP_WORDS.has(normalizeText(word)),
  );
  if (!words.length) return null;
  const count = Math.max(1, Math.min(3, Math.round(clean.split(" ").length / 14)));
  const hidden = words.sort((a, b) => b.length - a.length).slice(0, count);
  let front = clean;
  for (const word of hidden) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    front = front.replace(pattern, "⟦…⟧");
  }
  return { front, hidden };
}
function parseQuestionAnswer(text) {
  const match = String(text || "").match(/^\s*(.+?)\s*::\s*(.+?)\s*$/s);
  return match ? { question: match[1], answer: match[2] } : null;
}
// Crea las tarjetas que falten a partir de resaltados, notas y cuaderno.
function syncCardsFromNotes() {
  if (!currentBook) return 0;
  const cards = studyCards();
  const known = new Set(cards.map((card) => card.sourceKey).filter(Boolean));
  const added = [];
  const add = (card) => {
    if (card.sourceKey && known.has(card.sourceKey)) return;
    known.add(card.sourceKey);
    added.push(card);
  };
  for (const mark of annotations()) {
    if (mark.type === "sticky") {
      for (const line of String(mark.note || "").split(/\n+/)) {
        const lineQa = parseQuestionAnswer(line);
        if (lineQa) add(newCard(lineQa.question, lineQa.answer, { page: mark.page, sourceKey: `ann:${mark.id}:${hashText(line)}`, origin: "nota" }));
      }
      continue;
    }
    const qa = parseQuestionAnswer(mark.note);
    if (qa) {
      add(newCard(qa.question, qa.answer, { page: mark.page, sourceKey: `ann:${mark.id}:qa`, origin: "nota" }));
      continue;
    }
    if (!["highlight", "underline", "wavy", "note"].includes(mark.type)) continue;
    const text = String(mark.text || "").trim();
    if (text.split(/\s+/).length < 4) continue;
    const cloze = makeCloze(text);
    if (!cloze) continue;
    add(newCard(cloze.front, text + (mark.note ? `\n\nTu nota: ${mark.note}` : ""), { page: mark.page, sourceKey: `ann:${mark.id}`, origin: "resaltado" }));
  }
  for (const [page, entry] of Object.entries(pageNotesStore())) {
    for (const line of String(entry.text || "").split(/\n+/)) {
      const qa = parseQuestionAnswer(line);
      if (qa) add(newCard(qa.question, qa.answer, { page: Number(page), sourceKey: `pn:${page}:${hashText(line)}`, origin: "cuaderno" }));
    }
  }
  if (added.length) saveStudyCards([...cards, ...added]);
  return added.length;
}
function scheduleCard(card, grade) {
  const next = { ...card };
  if (grade === 0) {
    next.reps = 0;
    next.lapses = (next.lapses || 0) + 1;
    next.interval = 0;
    next.ease = Math.max(1.3, next.ease - 0.2);
    next.due = Date.now() + 10 * 60_000;
    return next;
  }
  if (next.reps === 0) next.interval = grade === 3 ? 4 : grade === 1 ? 0.5 : 1;
  else if (next.reps === 1) next.interval = grade === 3 ? 8 : grade === 1 ? 3 : 6;
  else next.interval = Math.round(next.interval * (grade === 1 ? 1.2 : grade === 3 ? next.ease * 1.3 : next.ease) * 10) / 10;
  next.ease = Math.max(1.3, Math.min(3.2, next.ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0)));
  next.reps++;
  next.due = Date.now() + next.interval * DAY_MS;
  return next;
}
function formatInterval(days) {
  if (days <= 0) return "10 min";
  if (days < 1) return `${Math.round(days * 24)} h`;
  if (days < 30) return `${Math.round(days)} d`;
  if (days < 365) return `${Math.round(days / 30)} mes${Math.round(days / 30) > 1 ? "es" : ""}`;
  return `${(days / 365).toFixed(1)} años`;
}
function dueCards(cards = studyCards()) {
  const now = Date.now();
  return cards.filter((card) => card.due <= now).sort((a, b) => a.due - b.due);
}
function updateStudyLaunch() {
  const badge = $("studyLaunchDue");
  if (!badge) return;
  const cards = studyCards();
  const due = dueCards(cards).length;
  badge.hidden = !due;
  badge.textContent = String(due);
  $("studyLaunchMeta").textContent = cards.length ? `${cards.length} tarjeta${cards.length > 1 ? "s" : ""} · ${due ? `${due} para hoy` : "al día"}` : "Tarjetas con repaso espaciado";
}
function openStudy(view = "overview") {
  if (!currentBook) return toast("Abre un documento primero");
  $("studyTitle").textContent = currentBook.name;
  $("studyPanel").hidden = false;
  if (view === "overview") {
    const added = syncCardsFromNotes();
    renderStudyOverview(added);
  }
  $("studyPanel").querySelector(".study-card").focus();
}
function closeStudy() {
  $("studyPanel").hidden = true;
  updateStudyLaunch();
}
function renderStudyOverview(added = 0) {
  const cards = studyCards();
  const due = dueCards(cards);
  const learned = cards.filter((card) => card.interval >= 21).length;
  const fresh = cards.filter((card) => card.reps === 0).length;
  const next = cards.filter((card) => card.due > Date.now()).sort((a, b) => a.due - b.due)[0];
  $("studyBody").innerHTML = `<div class="study-stats"><div class="study-stat study-stat-main"><strong>${due.length}</strong><small>para repasar hoy</small></div><div class="study-stat"><strong>${fresh}</strong><small>nuevas</small></div><div class="study-stat"><strong>${learned}</strong><small>aprendidas (≥ 3 sem.)</small></div><div class="study-stat"><strong>${cards.length}</strong><small>en total</small></div></div>
  <div class="study-actions">
    <button class="btn primary-action" data-study="review" ${due.length ? "" : "disabled"}>${due.length ? `Empezar repaso · ${due.length} tarjeta${due.length > 1 ? "s" : ""}` : "Nada pendiente por hoy"}<small>${due.length ? "Espacio muestra la respuesta · 1–4 para calificar" : next ? `Próxima tarjeta ${new Date(next.due).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" })}` : "Crea tarjetas para empezar"}</small></button>
    <button class="btn" data-study="ai">Generar tarjetas de la página ${currentPage} con IA local<small>El texto no sale de tu dispositivo</small></button>
    <button class="btn" data-study="new">Nueva tarjeta<small>Escribe una pregunta y su respuesta</small></button>
  </div>
  <p class="study-hint">${added ? `<b>${added} tarjeta${added > 1 ? "s nuevas" : " nueva"}</b> a partir de tus notas. ` : ""}Las tarjetas se crean solas desde tus resaltados (ejercicio de huecos) y desde las notas escritas como <code>pregunta :: respuesta</code>, también en el cuaderno.</p>
  ${cards.length ? `<div class="study-list"><h3>Tarjetas</h3>${[...cards]
    .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
    .map((card) => `<div class="study-item"><span title="${escapeHtml(card.front)}">${escapeHtml(card.front.replace(/⟦…⟧/g, "___"))}</span><small>p. ${card.page} · ${card.reps ? formatInterval(card.interval) : "nueva"}</small><button class="btn icon" data-study-delete="${card.id}" aria-label="Eliminar tarjeta">×</button></div>`)
    .join("")}</div>` : ""}`;
}
function startStudyReview() {
  studyQueue = dueCards().map((card) => card.id);
  studyIndex = 0;
  studyReviewed = 0;
  studyRevealed = false;
  if (!studyQueue.length) return renderStudyOverview();
  renderStudyCard();
  $("studyPanel").querySelector(".study-card").focus();
}
function renderStudyCard() {
  const cards = studyCards();
  const card = cards.find((item) => item.id === studyQueue[studyIndex]);
  if (!card) {
    $("studyBody").innerHTML = `<div class="study-done"><strong>¡Repaso completado!</strong><p>${studyReviewed} tarjeta${studyReviewed === 1 ? "" : "s"} repasada${studyReviewed === 1 ? "" : "s"}. Vuelve cuando toque: el repaso espaciado hace el resto.</p><div class="study-reveal"><button class="btn" data-study="overview">Volver al resumen</button></div></div>`;
    updateStudyLaunch();
    return;
  }
  const front = escapeHtml(card.front).replace(/⟦…⟧/g, '<span class="cloze">_____</span>');
  let back = escapeHtml(card.back);
  if (card.front.includes("⟦…⟧") && studyRevealed) {
    // Resalta en la respuesta las palabras que estaban ocultas.
    const hidden = makeCloze(card.back.split("\n\nTu nota:")[0])?.hidden || [];
    for (const word of hidden) back = back.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${escapeHtml(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}])`, "u"), "<mark>$1</mark>");
  }
  const previews = [0, 1, 2, 3].map((grade) => formatInterval(scheduleCard(card, grade).interval));
  const labels = ["Otra vez", "Difícil", "Bien", "Fácil"];
  $("studyBody").innerHTML = `<div class="study-progress"><b style="width:${(studyIndex / studyQueue.length) * 100}%"></b></div>
  <div class="flashcard"><div class="flashcard-front">${front}</div>${studyRevealed ? `<div class="flashcard-back">${back}</div>` : ""}<div class="flashcard-source">Tarjeta ${studyIndex + 1} de ${studyQueue.length} · ${escapeHtml(card.origin || "manual")} · <button data-study-page="${card.page}">página ${card.page}</button></div></div>
  ${studyRevealed
    ? `<div class="study-grades">${labels.map((label, grade) => `<button data-grade="${grade}"><span>${grade + 1} · ${label}</span><small>${previews[grade]}</small></button>`).join("")}</div>`
    : `<div class="study-reveal"><button class="btn" data-study="reveal">Mostrar respuesta</button></div>`}`;
}
function gradeStudyCard(grade) {
  if (!studyRevealed) return;
  const cards = studyCards();
  const index = cards.findIndex((item) => item.id === studyQueue[studyIndex]);
  if (index < 0) return;
  cards[index] = scheduleCard(cards[index], grade);
  saveStudyCards(cards);
  // «Otra vez» vuelve a aparecer al final de esta misma sesión.
  if (grade === 0) studyQueue.push(cards[index].id);
  studyReviewed++;
  studyIndex++;
  studyRevealed = false;
  renderStudyCard();
}
function renderStudyEditor(front = "", back = "", page = currentPage) {
  $("studyPanel").hidden = false;
  $("studyTitle").textContent = currentBook?.name || "Tarjetas";
  $("studyBody").innerHTML = `<div class="study-editor"><label>Pregunta o texto con huecos (escribe ⟦…⟧ para un hueco)<textarea id="studyFront">${escapeHtml(front)}</textarea></label><label>Respuesta<textarea id="studyBack">${escapeHtml(back)}</textarea></label><footer><button class="btn" data-study="overview">Cancelar</button><button class="btn primary-action" data-study="save" data-page="${page}">Guardar tarjeta</button></footer></div>`;
  $("studyFront").focus();
}
function createCardFromSelection() {
  const text = window.getSelection()?.toString().replace(/\s+/g, " ").trim();
  if (!text) return toast("Selecciona un fragmento primero");
  hideAnnotationActions();
  const cloze = makeCloze(text);
  renderStudyEditor(cloze?.front || "", text, currentPage);
}
// Completa un prompt con la IA local sin pasar por el panel del asistente.
async function completeLocalAi(prompt) {
  const capability = await inspectAiCapability();
  if (capability.kind === "none") throw new Error(capability.reason);
  if (capability.kind === "builtin") {
    const base = await getBuiltInAi();
    if (!base) throw new Error("La IA integrada no está disponible.");
    const session = base.clone ? await base.clone() : base;
    try {
      return String(await session.prompt(prompt));
    } finally {
      if (session !== base) session.destroy?.();
    }
  }
  const engine = await getWebLlmAi();
  const reply = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 700,
  });
  return reply.choices?.[0]?.message?.content || "";
}
async function generateCardsWithAi() {
  if (!pdfDoc || !currentBook) return toast("Abre un PDF primero");
  const text = (await getPagePlainText(currentPage)).slice(0, 6000);
  if (text.trim().length < 80) return toast("Esta página tiene poco texto para generar tarjetas");
  $("studyPanel").hidden = false;
  $("studyBody").innerHTML = '<div class="study-done"><strong>Generando tarjetas…</strong><p>La IA local está leyendo la página. La primera vez puede tardar mientras se prepara el modelo.</p></div>';
  try {
    const answer = await completeLocalAi(`Eres un profesor. A partir del TEXTO, crea entre 3 y 6 tarjetas de estudio en español sobre las ideas más importantes. Responde SOLO con líneas con este formato exacto, una tarjeta por línea:\nP: <pregunta concreta> || R: <respuesta breve y correcta>\n\nTEXTO (página ${currentPage}):\n"""${text}"""`);
    const cards = String(answer)
      .split(/\n+/)
      .map((line) => line.match(/P\s*:\s*(.+?)\s*\|\|\s*R\s*:\s*(.+)/i))
      .filter(Boolean)
      .map((match) => newCard(match[1], match[2], { page: currentPage, sourceKey: `ai:${currentPage}:${hashText(match[1])}`, origin: "IA" }));
    const known = new Set(studyCards().map((card) => card.sourceKey));
    const fresh = cards.filter((card) => !known.has(card.sourceKey));
    if (!fresh.length) throw new Error("La IA no devolvió tarjetas con el formato esperado.");
    saveStudyCards([...studyCards(), ...fresh]);
    renderStudyOverview();
    toast(`${fresh.length} tarjeta${fresh.length > 1 ? "s" : ""} creada${fresh.length > 1 ? "s" : ""} con IA`);
  } catch (error) {
    console.error(error);
    renderStudyOverview();
    toast(friendlyAiError(error));
  }
}
// Lanza el asistente con un ámbito y una pregunta ya preparados.
async function runAiPreset(scope, question) {
  if (!currentBook) return toast("Abre un documento primero");
  if (scope === "selection" && !window.getSelection()?.toString().trim()) return toast("Selecciona un fragmento primero");
  if (scope === "selection") await openAiAssistant();
  else {
    $("aiCard")?._expandAi?.();
    $("aiScope").value = scope;
    $("aiScope").dispatchEvent(new Event("change"));
    $("aiPanel").hidden = false;
    setAssistantButton(true);
  }
  $("aiQuestion").value = question;
  askLocalAi();
}
function bindStudy() {
  $("studyLaunchBtn").onclick = () => openStudy();
  $("closeStudy").onclick = closeStudy;
  $("cardFromSelectionBtn").onclick = createCardFromSelection;
  $("studyPanel").addEventListener("pointerdown", (event) => {
    if (event.target === $("studyPanel")) closeStudy();
  });
  $("studyBody").addEventListener("click", (event) => {
    const action = event.target.closest("[data-study]")?.dataset.study;
    const grade = event.target.closest("[data-grade]")?.dataset.grade;
    const remove = event.target.closest("[data-study-delete]")?.dataset.studyDelete;
    const page = event.target.closest("[data-study-page]")?.dataset.studyPage;
    if (grade !== undefined) return gradeStudyCard(Number(grade));
    if (remove) {
      saveStudyCards(studyCards().filter((card) => card.id !== remove));
      return renderStudyOverview();
    }
    if (page) {
      closeStudy();
      return jumpToPage(Number(page));
    }
    if (action === "review") startStudyReview();
    else if (action === "reveal") {
      studyRevealed = true;
      renderStudyCard();
    } else if (action === "overview") renderStudyOverview();
    else if (action === "new") renderStudyEditor();
    else if (action === "ai") generateCardsWithAi();
    else if (action === "save") {
      const front = $("studyFront").value.trim();
      const back = $("studyBack").value.trim();
      if (!front || !back) return toast("Escribe la pregunta y la respuesta");
      saveStudyCards([...studyCards(), newCard(front, back, { page: Number(event.target.closest("[data-page]")?.dataset.page) || currentPage, origin: "manual" })]);
      renderStudyOverview();
      toast("Tarjeta guardada");
    }
  });
  $("studyPanel").addEventListener("keydown", (event) => {
    if (event.target.matches("textarea, input")) {
      if (event.key === "Escape") {
        event.stopPropagation();
        renderStudyOverview();
      }
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      closeStudy();
    } else if (event.key === " " && !studyRevealed && $("studyBody").querySelector('[data-study="reveal"]')) {
      event.preventDefault();
      studyRevealed = true;
      renderStudyCard();
    } else if (/^[1-4]$/.test(event.key) && studyRevealed) {
      event.preventDefault();
      gradeStudyCard(Number(event.key) - 1);
    }
  });
}
function bindNotebook() {
  const panel = $("notebookPanel");
  setIcon("closeNotebook", "close");
  setIcon("notesNewBtn", "plus", "Apunte");
  setIcon("notesPinBtn", "pin", "En la página");
  $("notesNewBtn").title = "Nuevo apunte para esta página";
  $("notesPinBtn").title = "Pegar una nota en un punto de la página (N)";
  setNotesMinimized(localStorage.getItem("paper.notes-minimized") === "1");
  $("notebookBtn").onclick = toggleNotebook;
  $("closeNotebook").onclick = closeNotebook;
  $("notesMinimize").onclick = () => setNotesMinimized(!panel.classList.contains("is-minimized"));
  $("stickyNoteBtn").onclick = () => setStickyPlacement(!stickyPlacement);
  $("notesNewBtn").onclick = () => {
    notebookTab = "page";
    createPageNote();
  };
  $("notesPinBtn").onclick = () => setStickyPlacement(true);
  document.querySelectorAll("[data-notebook-tab]").forEach((button) => {
    button.onclick = () => {
      notebookTab = button.dataset.notebookTab;
      renderNotebook({ keepScroll: false });
    };
  });
  panel.addEventListener("input", (event) => {
    const field = event.target.closest("[data-note-text]");
    if (!field) return;
    field.rows = Math.min(14, Math.max(2, field.value.split("\n").length + 1));
    scheduleNoteText(field.dataset.noteText);
  });
  panel.addEventListener("focusout", (event) => {
    const field = event.target.closest?.("[data-note-text]");
    if (field && noteTextTimers.has(field.dataset.noteText)) {
      clearTimeout(noteTextTimers.get(field.dataset.noteText));
      saveNoteText(field.dataset.noteText);
    }
  });
  panel.addEventListener("focusin", (event) => {
    const card = event.target.closest?.(".nw-card");
    if (!card) return;
    panel.querySelectorAll(".nw-card.is-active").forEach((item) => item !== card && item.classList.remove("is-active"));
    card.classList.add("is-active");
    const id = card.dataset.note;
    if (id !== "doc" && activeStickyId !== id) {
      activeStickyId = id;
      renderStickyNotes();
    }
  });
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const mode = target.closest("[data-note-mode]")?.dataset.noteMode;
    if (mode) return setNoteTool({ mode });
    const inkColor = target.closest("[data-note-ink]")?.dataset.noteInk;
    if (inkColor) return setNoteTool(noteTool.mode === "highlight" ? { highlight: inkColor } : { ink: inkColor });
    const width = target.closest("[data-note-width]")?.dataset.noteWidth;
    if (width) return setNoteTool({ width });
    if (target.closest("[data-note-undo]")) return undoNoteInk();
    if (target.closest("[data-empty-new]")) return createPageNote();
    if (target.closest("[data-empty-pin]")) return setStickyPlacement(true);
    const colorId = target.closest("[data-note-color]")?.dataset.noteColor;
    if (colorId) {
      const mark = annotations().find((item) => item.id === colorId);
      const next = STICKY_COLORS[(STICKY_COLORS.indexOf(mark?.color || "yellow") + 1) % STICKY_COLORS.length];
      localStorage.setItem("paper.sticky-color", next);
      suppressNotebookRender = true;
      try {
        updateAnnotation(colorId, { color: next });
      } finally {
        suppressNotebookRender = false;
      }
      renderNotebook({ focusId: colorId });
      return;
    }
    const pinId = target.closest("[data-note-pin]")?.dataset.notePin;
    if (pinId) {
      const mark = annotations().find((item) => item.id === pinId);
      if (isPinned(mark)) {
        suppressNotebookRender = true;
        try {
          updateAnnotation(pinId, { x: null, y: null });
        } finally {
          suppressNotebookRender = false;
        }
        renderNotebook({ focusId: pinId });
        toast("La nota ya no está anclada a la página");
      } else setStickyPlacement(true, pinId);
      return;
    }
    const deleteId = target.closest("[data-note-delete]")?.dataset.noteDelete;
    if (deleteId) {
      noteTextTimers.delete(deleteId);
      suppressNotebookRender = true;
      try {
        deleteAnnotation(deleteId);
      } finally {
        suppressNotebookRender = false;
      }
      if (activeStickyId === deleteId) activeStickyId = null;
      renderStickyNotes();
      renderNotebook();
      return;
    }
    const page = target.closest("[data-notebook-page]");
    if (page) {
      notebookTab = "page";
      jumpToPage(Number(page.dataset.notebookPage)).then(() => renderNotebook({ keepScroll: false }));
      return;
    }
    if (target.closest("[data-notebook-doc]")) {
      notebookTab = "doc";
      renderNotebook({ keepScroll: false });
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeNotebook();
    }
  });
  // Arrastrar desde la cabecera; el tamaño se ajusta desde la esquina.
  let drag = null;
  $("notesDragHandle").addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") || window.innerWidth <= 700) return;
    const box = panel.getBoundingClientRect();
    drag = { id: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top };
    $("notesDragHandle").setPointerCapture(event.pointerId);
    panel.classList.add("is-dragging");
  });
  $("notesDragHandle").addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 120, event.clientX - drag.dx))}px`;
    panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 52, event.clientY - drag.dy))}px`;
  });
  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    panel.classList.remove("is-dragging");
    saveNotesWindowGeometry();
  };
  $("notesDragHandle").addEventListener("pointerup", endDrag);
  $("notesDragHandle").addEventListener("pointercancel", endDrag);
  $("notesDragHandle").addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) setNotesMinimized(!panel.classList.contains("is-minimized"));
  });
  let resizeFrame = 0;
  new ResizeObserver(() => {
    if (panel.hidden || panel.classList.contains("is-minimized")) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      panel.querySelectorAll("[data-ink-host]").forEach((host) => {
        const target = inkTargetOf(host);
        paintInkHost(host, target.kind === "doc" ? documentNoteInk() : annotations().find((mark) => mark.id === target.id)?.ink);
      });
      saveNotesWindowGeometry();
    });
  }).observe(panel);
  window.addEventListener("resize", () => {
    if (!panel.hidden) applyNotesWindowGeometry();
  }, { passive: true });
  window.addEventListener("pagehide", flushNotebook);
}

async function drainPageRenderQueue() {
  if (pageRenderActive) return;
  pageRenderActive = true;
  while (pageRenderPending) {
    const request = pageRenderPending;
    pageRenderPending = null;
    let completed = false;
    try {
      completed = await performPageRender(request.pageNumber, request.options, request.requestId);
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") console.error("No se pudo renderizar la página", error);
    }
    request.resolve(completed);
  }
  pageRenderActive = false;
}
async function performPageRender(num, options = {}, requestId = pageRenderRequestId) {
  if (!pdfDoc) return;
  const previousPage = currentPage;
  if (num !== previousPage) flushReadingSession(false);
  const { anchor = null, resetScroll = num !== previousPage } = options;
  const token = ++renderToken;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {}
  }
  hideAnnotationActions();
  if (num !== previousPage && selectedAnnotationId) {
    selectedAnnotationId = null;
    $("annotationEditor").hidden = true;
  }
  currentPage = Math.max(1, Math.min(pdfDoc.numPages, num));
  readingSession.page = currentPage;
  if (currentPage !== previousPage) navigationDirection = currentPage > previousPage ? 1 : -1;
  updatePageColor();
  const page = await getCachedPage(currentPage);
  if (token !== renderToken || requestId !== pageRenderRequestId) return false;
  const viewport = page.getViewport({ scale, rotation });
  // PDF.js vuelve a dibujar el vector en cada nivel de zoom. El lienzo se
  // prepara a densidad de pantalla (hasta 3x), así que no ampliamos un bitmap
  // ya renderizado mediante CSS.
  const targetDpr = Math.min(window.devicePixelRatio || 1, 3);
  // El límite evita que un PDF enorme a 500% bloquee el navegador; seguimos
  // renderizando desde el vector de origen y reducimos sólo la sobremuestra.
  const maxCanvasPixels = 24_000_000;
  const dpr = Math.min(targetDpr, Math.sqrt(maxCanvasPixels / (viewport.width * viewport.height)));
  const canvas = $("pdfCanvas"),
    ctx = canvas.getContext("2d");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  $("canvasWrap").style.width = `${viewport.width}px`;
  $("canvasWrap").style.height = `${viewport.height}px`;
  renderTask = page.render({
    canvasContext: ctx,
    viewport,
    transform: [dpr, 0, 0, dpr, 0, 0],
  });
  try {
    await renderTask.promise;
  } catch (error) {
    renderTask = null;
    if (error?.name !== "RenderingCancelledException") throw error;
    return false;
  }
  renderTask = null;
  if (token !== renderToken || requestId !== pageRenderRequestId) return false;
  localStorage.setItem(key(currentBook.id, "page"), String(currentPage));
  localStorage.setItem(key(currentBook.id, "scale"), String(scale));
  localStorage.setItem(key(currentBook.id, "rotation"), String(rotation));
  updateZoomLabel();
  updatePageChrome();
  if (anchor) restoreZoomAnchor(anchor);
  else if (resetScroll) $("viewer").scrollTo({ top: 0, left: 0 });
  await renderTextLayer(page, viewport);
  if (token !== renderToken || requestId !== pageRenderRequestId) return false;
  renderLinkLayer(page, viewport, token);
  if (reflowMode) await renderReflowPage(page);
  $("canvasWrap").hidden = reflowMode;
  $("reflowReader").hidden = !reflowMode;
  renderAnnotations();
  updateThumbSelection();
  updateOutlineSelection();
  if (viewMode === "double") renderFacingPage(token);
  else $("facingWrap").hidden = true;
  if (presentationMode) updatePresentationCount();
  prefetchAdjacentPages(currentPage);
  return true;
}
function reflowLines(items) {
  const lines = [];
  let current = null;
  for (const item of items.filter((entry) => entry.str?.trim())) {
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    const size = Math.max(6, Math.abs(Number(item.transform?.[0] || item.height || 12)));
    const changedLine = !current || Math.abs(current.y - y) > Math.max(2.5, size * 0.28);
    if (changedLine) {
      current = { y, x, size, chunks: [], hasEol: false };
      lines.push(current);
    }
    current.chunks.push({ x, text: item.str });
    current.size = Math.max(current.size, size);
    current.hasEol ||= Boolean(item.hasEOL);
    if (item.hasEOL) current = null;
  }
  return lines.map((line) => ({
    ...line,
    text: line.chunks
      .sort((a, b) => a.x - b.x)
      .map((chunk) => chunk.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+([,.;:!?])/g, "$1"),
  })).filter((line) => line.text);
}

function reflowBlocks(items) {
  const lines = reflowLines(items);
  if (!lines.length) return [];
  const sizes = lines.map((line) => line.size).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 12;
  const blocks = [];
  let paragraph = null;
  const flush = () => {
    if (paragraph?.text) blocks.push(paragraph);
    paragraph = null;
  };
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const short = line.text.length < 110;
    const heading = line.size >= bodySize * 1.22 && short;
    const list = line.text.match(/^([•●▪◦‣·]|[-–—]|\d+[.)]|[a-zA-Z][.)])\s+(.+)/);
    const gap = previous ? Math.abs(previous.y - line.y) : 0;
    const paragraphBreak = previous && (gap > Math.max(previous.size, line.size) * 1.75 || Math.abs(line.x - previous.x) > bodySize * 2.4);
    if (heading) {
      flush();
      blocks.push({ type: line.size >= bodySize * 1.65 ? "h2" : "h3", text: line.text });
      return;
    }
    if (list) {
      flush();
      const last = blocks.at(-1);
      if (last?.type === "list") last.items.push(list[2]);
      else blocks.push({ type: "list", items: [list[2]] });
      return;
    }
    if (!paragraph || paragraphBreak) {
      flush();
      paragraph = { type: "p", text: line.text };
      return;
    }
    const joinsWord = paragraph.text.endsWith("-") && /^[a-záéíóúüñ]/i.test(line.text);
    paragraph.text = joinsWord
      ? `${paragraph.text.slice(0, -1)}${line.text}`
      : `${paragraph.text} ${line.text}`;
    if (!next) flush();
  });
  flush();
  return blocks;
}
async function renderReflowPage(page) {
  const reader = $("reflowReader");
  const content = await getCachedTextContent(page);
  const blocks = reflowBlocks(content.items);
  if (!blocks.length) {
    reader.innerHTML = '<div class="reflow-empty"><strong>Esta página no contiene texto extraíble.</strong><p>Puedes volver a PDF para conservar la composición original.</p></div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  const marker = document.createElement("div");
  marker.className = "reflow-page-marker";
  marker.innerHTML = `<span>Página</span><strong>${currentPage}</strong><small>de ${pdfDoc.numPages}</small>`;
  fragment.append(marker);
  blocks.forEach((block) => {
    if (block.type === "list") {
      const list = document.createElement("ul");
      block.items.forEach((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        list.append(item);
      });
      fragment.append(list);
      return;
    }
    const element = document.createElement(block.type);
    element.textContent = block.text;
    fragment.append(element);
  });
  reader.replaceChildren(fragment);
}
function prefetchAdjacentPages(pageNumber) {
  if (!pdfDoc) return;
  cancelScheduledPrefetch();
  const direction = navigationDirection || 1;
  const candidates = [pageNumber + direction, pageNumber + direction * 2, pageNumber - direction]
    .filter((page, index, pages) => page >= 1 && page <= pdfDoc.numPages && pages.indexOf(page) === index);
  const run = async (deadline) => {
    prefetchHandle = 0;
    for (const candidate of candidates) {
      if (pageRenderPending || (deadline?.timeRemaining && deadline.timeRemaining() < 4)) break;
      try {
        const page = await getCachedPage(candidate);
        if (!pageRenderPending && Math.abs(candidate - currentPage) === 1)
          getCachedTextContent(page).catch(() => {});
      } catch {}
    }
  };
  prefetchHandle = "requestIdleCallback" in window
    ? window.requestIdleCallback(run, { timeout: 500 })
    : setTimeout(() => run(), 80);
}
function scheduleScrubPage(pageNumber) {
  scrubTarget = pageNumber;
  if (scrubFrame) return;
  scrubFrame = requestAnimationFrame(() => {
    scrubFrame = 0;
    if (scrubTarget === currentPage) return;
    if (viewMode === "continuous") scrollToContinuousPage(scrubTarget, { smooth: false });
    else renderPage(scrubTarget);
  });
}
async function renderTextLayer(page, viewport) {
  const layer = $("textLayer");
  layer.replaceChildren();
  layer.style.width = `${viewport.width}px`;
  layer.style.height = `${viewport.height}px`;
  layer.style.setProperty("--scale-factor", String(viewport.scale));
  try {
    const content = await getCachedTextContent(page);
    recordPageDensity(page.pageNumber, content);
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: content,
      container: layer,
      viewport,
    });
    await textLayer.render();
    paintSearchHits();
  } catch (e) {
    console.error("No se pudo crear la capa de texto", e);
  }
}
// ---- Capa de enlaces clicables ----
// Los enlaces internos saltan a su página (registrando historial); las URLs
// externas se abren en una pestaña nueva. La capa se reconstruye por página.
async function renderLinkLayer(page, viewport, token) {
  return renderLinkLayerInto($("linkLayer"), page, viewport, token);
}
async function renderLinkLayerInto(layer, page, viewport, token) {
  if (!layer) return;
  layer.replaceChildren();
  layer.style.width = `${viewport.width}px`;
  layer.style.height = `${viewport.height}px`;
  if (reflowMode) return;
  let annots;
  try {
    annots = await page.getAnnotations({ intent: "display" });
  } catch {
    return;
  }
  if (token !== renderToken) return;
  const links = annots.filter(
    (annotation) => annotation.subtype === "Link" && (annotation.url || annotation.dest),
  );
  const fragment = document.createDocumentFragment();
  for (const link of links) {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(link.rect);
    const left = Math.min(x1, x2),
      top = Math.min(y1, y2),
      width = Math.abs(x2 - x1),
      height = Math.abs(y2 - y1);
    if (width < 1 || height < 1) continue;
    const anchor = document.createElement("a");
    anchor.style.left = `${left}px`;
    anchor.style.top = `${top}px`;
    anchor.style.width = `${width}px`;
    anchor.style.height = `${height}px`;
    if (link.url) {
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.className = "external";
      anchor.title = link.url;
    } else {
      anchor.href = "#";
      anchor.title = "Ir a la sección enlazada";
      anchor.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          const page = await resolveDestPage(link.dest);
          if (!page) throw new Error("Destino no válido");
          jumpToPage(page);
        } catch {
          toast("No se pudo abrir el enlace");
        }
      });
    }
    fragment.append(anchor);
  }
  layer.append(fragment);
}
function paintSearchHits() {
  if (!searchRegex) return;
  // Copia sin la bandera global para poder usar .test() sin arrastrar lastIndex.
  const matcher = new RegExp(searchRegex.source, searchRegex.flags.replace("g", ""));
  document
    .querySelectorAll("#textLayer span")
    .forEach((span) => span.classList.toggle("search-hit", matcher.test(span.textContent)));
}

// ---- Modos de zoom ----
// "auto": ancho cómodo de lectura (la página nunca pasa de ~1080px de ancho,
//         y las apaisadas se ven enteras); "width": llena el ancho del visor;
// "page": la página completa cabe en pantalla; "custom": zoom manual.
// Salvo en "custom", el zoom se recalcula al cambiar el tamaño de la ventana.
const AUTO_ZOOM_MAX_WIDTH = 1080;
let zoomMode = "auto";
let zoomModeBeforePresentation = null;
async function computeZoomForMode(mode, pageNumber = currentPage) {
  const page = await getCachedPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation });
  const viewer = $("viewer");
  const style = getComputedStyle(viewer);
  const availableWidth = viewer.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0) - 4;
  const availableHeight = viewer.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0) - 6;
  const pages = viewMode === "double" && window.innerWidth > 760 ? 2 : 1;
  const widthScale = (availableWidth - (pages - 1) * 14) / pages / base.width;
  const pageScale = Math.min(widthScale, availableHeight / base.height);
  let next = widthScale;
  if (mode === "page") next = pageScale;
  else if (mode === "auto") {
    next = base.width > base.height
      ? pageScale
      : Math.min(widthScale, Math.max(1, AUTO_ZOOM_MAX_WIDTH / pages / base.width));
  }
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next * 100) / 100));
}
// Compatibilidad: escala para llenar el ancho.
function computeFitScale(pageNumber = currentPage) {
  return computeZoomForMode("width", pageNumber);
}
function persistZoomMode() {
  if (currentBook) localStorage.setItem(key(currentBook.id, "zoom-mode"), zoomMode);
}
async function applyZoomMode(mode = zoomMode, { persist = true } = {}) {
  if (!pdfDoc) return;
  zoomMode = mode;
  if (persist) persistZoomMode();
  if (mode === "custom" || reflowMode) {
    updateZoomLabel();
    return;
  }
  scale = await computeZoomForMode(mode);
  refreshCurrentView();
  updateZoomLabel();
}
// Reajuste tras un cambio de espacio disponible (ventana, paneles, pantalla
// completa): respeta el modo elegido y no toca un zoom manual.
function refitZoom() {
  if (pdfDoc && zoomMode !== "custom" && !reflowMode) applyZoomMode(zoomMode, { persist: false });
}
async function fitWidth() {
  return applyZoomMode("width");
}
async function fitPage() {
  return applyZoomMode("page");
}
function zoomAnchor(clientX, clientY) {
  const wrap = $("canvasWrap");
  const viewer = $("viewer");
  const rect = wrap.getBoundingClientRect();
  const viewerRect = viewer.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    clientX: clientX - viewerRect.left,
    clientY: clientY - viewerRect.top,
  };
}
function restoreZoomAnchor(anchor) {
  const viewer = $("viewer");
  const wrap = $("canvasWrap");
  viewer.scrollTo({
    left: Math.max(0, wrap.offsetLeft + wrap.clientWidth * anchor.x - anchor.clientX),
    top: Math.max(0, wrap.offsetTop + wrap.clientHeight * anchor.y - anchor.clientY),
    behavior: "auto",
  });
}
function updateZoomLabel() {
  const label = $("zoomLabel");
  if (!label) return;
  const percent = Math.round(scale * 100);
  const modeName = { auto: "Automático", width: "Ajustado al ancho", page: "Página completa" }[zoomMode];
  label.textContent = `${percent}%`;
  label.title = `Zoom ${percent}%${modeName ? ` · ${modeName}` : ""} · pulsa para elegir`;
  label.setAttribute("aria-label", label.title);
}
async function setZoom(nextScale, anchor = null) {
  if (!pdfDoc || reflowMode) return;
  const next = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale)) * 100) / 100;
  if (next === scale) return;
  scale = next;
  zoomMode = "custom";
  persistZoomMode();
  updateZoomLabel();
  if (viewMode === "continuous") refreshCurrentView();
  else await renderPage(currentPage, { anchor, resetScroll: false });
}
async function zoom(delta, anchor = null) {
  return setZoom(scale + delta, anchor);
}
function changeReaderZoom(delta) {
  if (!pdfDoc) return;
  if (!reflowMode) return zoom(delta);
  const next = Math.max(14, Math.min(36, Number(localStorage.getItem("paper.reflow-size") || 20) + Math.sign(delta)));
  localStorage.setItem("paper.reflow-size", String(next));
  applyReflowPreferences();
  $("zoomLabel").textContent = `${next}px`;
  $("zoomLabel").title = `Tamaño de lectura ${next}px`;
}
function renderBookmarks() {
  if (!currentBook) {
    $("bookmarkList").innerHTML = "";
    return;
  }
  const list = getJSON(key(currentBook.id, "bookmarks"), []);
  $("bookmarkList").innerHTML = list.length
    ? list
        .sort((a, b) => a - b)
        .map(
          (p) =>
            `<button class="bookmark" data-p="${p}"><strong>Página ${p}</strong><small>Ir al marcador</small></button>`,
        )
        .join("")
    : '<span style="color:var(--muted);font-size:13px">Sin marcadores.</span>';
  document
    .querySelectorAll("#bookmarkList .bookmark")
    .forEach((b) => (b.onclick = () => jumpToPage(Number(b.dataset.p))));
}
function toggleBookmark() {
  if (!currentBook) return;
  let list = getJSON(key(currentBook.id, "bookmarks"), []);
  if (list.includes(currentPage)) {
    list = list.filter((p) => p !== currentPage);
    toast("Marcador eliminado");
  } else {
    list.push(currentPage);
    toast("Página marcada");
  }
  setJSON(key(currentBook.id, "bookmarks"), list);
  renderBookmarks();
  updateBookmarkButton();
}
// ---- Índice (árbol plegable) ----
// El índice del PDF se construye como árbol: cada nivel se pliega, la sección
// en la que estás se despliega y se marca sola, y se puede filtrar por texto.
let outlineTree = [];
let activeOutlineId = "";
const outlineExpanded = new Set();
// Resuelve un destino a número de página. Algunos PDF guardan el índice de
// página como número en lugar de una referencia al objeto página.
async function resolveDestPage(dest) {
  try {
    if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
    if (!Array.isArray(dest) || dest[0] === null || dest[0] === undefined) return null;
    if (typeof dest[0] === "number") return Math.max(1, Math.min(pdfDoc.numPages, dest[0] + 1));
    return (await pdfDoc.getPageIndex(dest[0])) + 1;
  } catch {
    return null;
  }
}
async function buildOutlineTree(items, depth = 0, path = "") {
  return Promise.all(
    items.map(async (item, index) => {
      const id = path ? `${path}.${index}` : String(index);
      const children = item.items?.length ? await buildOutlineTree(item.items, depth + 1, id) : [];
      let page = await resolveDestPage(item.dest);
      if (!page && children.length) page = children.find((child) => child.page)?.page || null;
      return { id, title: String(item.title || "Sin título").replace(/\s+/g, " ").trim(), page, depth, children };
    }),
  );
}
function flattenOutline(nodes = outlineTree, out = []) {
  for (const node of nodes) {
    out.push(node);
    flattenOutline(node.children, out);
  }
  return out;
}
function outlineEntries() {
  const byId = new Map(flattenOutline().map((node) => [node.id, node]));
  return [...byId.values()]
    .filter((node) => node.page)
    .map((node) => ({
      title: node.title,
      page: node.page,
      depth: node.depth,
      path: outlineAncestors(node.id).map((id) => byId.get(id)?.title).filter(Boolean).join(" › "),
    }));
}
function outlineAncestors(id) {
  const parts = String(id).split(".");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
}
function renderOutlineTree() {
  const root = $("outlineList");
  if (!outlineTree.length) return;
  const query = normalizeText($("outlineFilter").value.trim());
  const activePath = new Set(outlineAncestors(activeOutlineId));
  const titleHtml = (title) => {
    if (!query) return escapeHtml(title);
    const at = normalizeText(title).indexOf(query);
    return at < 0 ? escapeHtml(title) : `${escapeHtml(title.slice(0, at))}<mark>${escapeHtml(title.slice(at, at + query.length))}</mark>${escapeHtml(title.slice(at + query.length))}`;
  };
  const renderNode = (node) => {
    const childHtml = node.children.map(renderNode).filter(Boolean);
    const matches = !query || normalizeText(node.title).includes(query);
    if (query && !matches && !childHtml.length) return "";
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && (query ? childHtml.length > 0 : outlineExpanded.has(node.id));
    const classes = ["outline-node", `depth-${Math.min(node.depth, 3)}`, node.id === activeOutlineId ? "is-active" : "", activePath.has(node.id) ? "in-path" : ""].filter(Boolean).join(" ");
    return `<li class="${classes}" role="treeitem"${hasChildren ? ` aria-expanded="${expanded}"` : ""}><div class="outline-row" style="--depth:${node.depth}">${hasChildren ? `<button class="outline-toggle" data-outline-toggle="${node.id}" aria-label="${expanded ? "Contraer" : "Expandir"} ${escapeHtml(node.title)}">${iconSvg("chevronRight")}</button>` : '<span class="outline-toggle-spacer"></span>'}<button class="outline-item${node.id === activeOutlineId ? " active" : ""}" data-outline-id="${node.id}"${node.page ? ` data-page="${node.page}"` : ""} title="${escapeHtml(node.title)}"><span class="outline-name">${titleHtml(node.title)}</span>${node.page ? `<span class="outline-page">${node.page}</span>` : ""}</button></div>${expanded ? `<ul role="group">${childHtml.join("")}</ul>` : ""}</li>`;
  };
  const html = outlineTree.map(renderNode).filter(Boolean).join("");
  root.innerHTML = html ? `<ul class="outline-tree" role="tree" aria-label="Índice del documento">${html}</ul>` : '<span class="outline-empty">Ninguna sección coincide.</span>';
}
async function renderOutline() {
  const root = $("outlineList");
  root.innerHTML = "";
  outlineTree = [];
  activeOutlineId = "";
  outlineExpanded.clear();
  $("outlineTools").hidden = true;
  $("outlineFilterWrap").hidden = true;
  $("outlineFilter").value = "";
  if (!pdfDoc) return;
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline?.length) {
      root.innerHTML = '<span class="outline-empty">Este PDF no incluye índice.</span>';
      return;
    }
    outlineTree = await buildOutlineTree(outline);
    const all = flattenOutline();
    const hasNesting = all.some((node) => node.children.length);
    $("outlineTools").hidden = !hasNesting;
    $("outlineFilterWrap").hidden = all.length < 12;
    // Índices cortos se muestran enteros; en los largos, sólo el primer nivel
    // (más la rama de la sección actual, que se despliega sola).
    if (all.length <= 24) all.forEach((node) => node.children.length && outlineExpanded.add(node.id));
    updateOutlineSelection(true);
  } catch (error) {
    console.error("No se pudo leer el índice", error);
    root.innerHTML = '<span class="outline-empty">No se pudo leer el índice.</span>';
  }
}
// Sección activa: la de página más alta que no supera la página actual (a
// igualdad, la última en el orden del documento, es decir, la más concreta).
function updateOutlineSelection(force = false) {
  if (!outlineTree.length) return;
  let best = null;
  for (const node of flattenOutline()) {
    if (node.page && node.page <= currentPage && (!best || node.page >= best.page)) best = node;
  }
  const nextId = best?.id || "";
  if (!force && nextId === activeOutlineId) return;
  activeOutlineId = nextId;
  outlineAncestors(nextId).forEach((id) => outlineExpanded.add(id));
  renderOutlineTree();
  const row = $("outlineList").querySelector(".outline-item.active");
  const sidebarVisible = document.body.classList.contains("sidebar-open") || (!isDrawerLayout() && !document.body.classList.contains("sidebar-collapsed"));
  if (row && sidebarVisible && !$("sidebarContentsPanel").hidden) row.scrollIntoView({ block: "nearest" });
}
function bindOutline() {
  setIcon("outlineExpandAll", "chevronDown");
  setIcon("outlineCollapseAll", "chevronUp");
  $("outlineFilterWrap").querySelector(".outline-filter-icon").innerHTML = iconSvg("search");
  $("outlineList").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-outline-toggle]")?.dataset.outlineToggle;
    if (toggle) {
      outlineExpanded.has(toggle) ? outlineExpanded.delete(toggle) : outlineExpanded.add(toggle);
      renderOutlineTree();
      return;
    }
    const item = event.target.closest(".outline-item");
    if (!item) return;
    const page = Number(item.dataset.page);
    if (page) {
      jumpToPage(page);
      if (isDrawerLayout()) document.body.classList.remove("sidebar-open");
    } else toast("No se pudo abrir esta sección");
  });
  $("outlineFilter").addEventListener("input", renderOutlineTree);
  $("outlineFilter").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.target.value) {
      event.stopPropagation();
      event.target.value = "";
      renderOutlineTree();
    }
    if (event.key === "Enter") ($("outlineList").querySelector(".outline-item[data-page]:has(mark)") || $("outlineList").querySelector(".outline-item[data-page]"))?.click();
  });
  $("outlineExpandAll").onclick = () => {
    flattenOutline().forEach((node) => node.children.length && outlineExpanded.add(node.id));
    renderOutlineTree();
  };
  $("outlineCollapseAll").onclick = () => {
    outlineExpanded.clear();
    renderOutlineTree();
  };
}
function cancelThumbnailWork() {
  thumbGeneration++;
  thumbRenderTasks.forEach((task) => {
    try { task.cancel(); } catch {}
  });
  thumbRenderTasks.clear();
  thumbQueue.forEach((card) => delete card.dataset.queued);
  thumbQueue = [];
}
function resetThumbnails() {
  thumbObserver?.disconnect();
  thumbObserver = null;
  cancelThumbnailWork();
  lastThumbPage = 0;
  $("thumbnailRail").hidden = true;
  $("thumbList").innerHTML = "";
  $("thumbProgress").textContent = "";
}
function updateThumbSelection() {
  if (!currentBook) return;
  const cards = [...document.querySelectorAll(".thumb")];
  cards.forEach((card) =>
    card.classList.toggle("active", Number(card.dataset.page) === currentPage),
  );
  $("thumbProgress").textContent =
    `Página ${currentPage} de ${pdfDoc.numPages}`;
  const active = document.querySelector(".thumb.active");
  if (active && !$("thumbnailRail").hidden) {
    const nearby = lastThumbPage > 0 && Math.abs(currentPage - lastThumbPage) <= 4;
    active.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: nearby ? "smooth" : "auto",
    });
    lastThumbPage = currentPage;
  }
}
function enqueueThumbnail(card) {
  if (card.dataset.ready || card.dataset.queued) return;
  card.dataset.queued = "1";
  thumbQueue.push(card);
  thumbQueue.sort(
    (a, b) => Math.abs(Number(a.dataset.page) - currentPage) - Math.abs(Number(b.dataset.page) - currentPage),
  );
  drainThumbnailQueue();
}
async function drainThumbnailQueue() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const card = thumbQueue.shift();
    thumbRunning++;
    renderThumbnail(card).finally(() => {
      thumbRunning--;
      drainThumbnailQueue();
    });
  }
}
async function renderThumbnail(card) {
  const generation = thumbGeneration;
  try {
    if (!pdfDoc || card.dataset.ready) return;
    card.classList.add("loading");
    const page = await getCachedPage(Number(card.dataset.page));
    if (generation !== thumbGeneration) return;
    const viewport = page.getViewport({ scale: 0.19, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    thumbRenderTasks.add(task);
    try { await task.promise; } finally { thumbRenderTasks.delete(task); }
    if (generation !== thumbGeneration || card.dataset.ready) return;
    card.prepend(canvas);
    card.dataset.ready = "1";
  } catch {
  } finally {
    delete card.dataset.queued;
    card.classList.remove("loading");
  }
}
function buildThumbnails() {
  if (!pdfDoc || $("thumbList").childElementCount) return;
  const list = $("thumbList");
  for (let page = 1; page <= pdfDoc.numPages; page++) {
    const card = document.createElement("button");
    card.className = "thumb";
    card.dataset.page = page;
    card.setAttribute("aria-label", `Ir a la página ${page}`);
    card.title = `Página ${page}`;
    card.innerHTML = `<span class="thumb-number"><small>Página</small>${page}</span>`;
    list.appendChild(card);
  }
  thumbObserver = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          enqueueThumbnail(entry.target);
          thumbObserver.unobserve(entry.target);
        }
      }),
    { root: list, rootMargin: "240px" },
  );
  document
    .querySelectorAll(".thumb")
    .forEach((card) => thumbObserver.observe(card));
  updateThumbNoteBadges();
  list.addEventListener("pointerdown", (event) => {
    thumbScrubStart = { x: event.clientX, page: currentPage };
    thumbWasDragged = false;
    list.setPointerCapture(event.pointerId);
  });
  list.addEventListener("pointermove", (event) => {
    if (!thumbScrubStart) return;
    const delta = event.clientX - thumbScrubStart.x;
    if (Math.abs(delta) < 10) return;
    thumbWasDragged = true;
    const target = Math.max(
      1,
      Math.min(pdfDoc.numPages, thumbScrubStart.page + Math.round(-delta / 72)),
    );
    scheduleScrubPage(target);
  });
  list.addEventListener("pointerup", (event) => {
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".thumb");
    const wasDragged = thumbWasDragged;
    thumbScrubStart = null;
    if (list.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId);
    if (!wasDragged && card) {
      thumbWasDragged = true;
      jumpToPage(Number(card.dataset.page));
    }
  });
  list.addEventListener(
    "click",
    (event) => {
      if (!thumbWasDragged) return;
      event.preventDefault();
      event.stopPropagation();
      thumbWasDragged = false;
    },
    true,
  );
  list.addEventListener("click", (event) => {
    const card = event.target.closest(".thumb");
    if (card) jumpToPage(Number(card.dataset.page));
  });
  // En ratón, la rueda vertical recorre horizontalmente la isla de páginas.
  // No cambia de página: sólo mueve el navegador visual, como en una galería.
  list.addEventListener("wheel", (event) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    list.scrollBy({ left: delta, behavior: "auto" });
  }, { passive: false });
  updateThumbSelection();
}
function toggleThumbnails() {
  if (!pdfDoc) return toast("Abre un PDF primero");
  const rail = $("thumbnailRail");
  rail.hidden = !rail.hidden;
  if (!rail.hidden) {
    buildThumbnails();
    document.querySelectorAll(".thumb:not([data-ready])").forEach((card) => thumbObserver?.observe(card));
    requestAnimationFrame(updateThumbSelection);
  } else {
    cancelThumbnailWork();
  }
  $("thumbBtn").classList.toggle("active", !rail.hidden);
}
function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportAnnotations() {
  if (!currentBook) return toast("Abre un PDF primero");
  const data = {
    schema: "paper-annotations",
    version: 2,
    document: currentBook.name,
    exportedAt: new Date().toISOString(),
    annotations: annotations(),
    pageNotes: pageNotesStore(),
    documentNote: documentNote(),
    documentNoteInk: documentNoteInk(),
  };
  downloadText(
    `${currentBook.name.replace(/\.pdf$/i, "")}-anotaciones.json`,
    JSON.stringify(data, null, 2),
    "application/json",
  );
  toast("Anotaciones exportadas");
}
function exportMarkdown() {
  if (!currentBook) return toast("Abre un PDF primero");
  const lines = [
    `# Anotaciones · ${currentBook.name}`,
    "",
    `Exportado: ${new Date().toLocaleString()}`,
    "",
  ];
  const docText = documentNote().trim();
  if (docText) lines.push("## Nota del documento", "", docText, "");
  const pageNotes = pageNotesStore();
  const marks = annotations();
  const pages = [...new Set([...Object.keys(pageNotes).map(Number), ...marks.map((mark) => mark.page)])].sort((a, b) => a - b);
  for (const page of pages) {
    lines.push(`## Página ${page}`, "");
    if (pageNotes[page]?.text) lines.push("### Apuntes", "", pageNotes[page].text.trim(), "");
    for (const mark of marks.filter((item) => item.page === page).sort((a, b) => a.createdAt - b.createdAt)) {
      lines.push(`### ${mark.type === "sticky" ? (isPinned(mark) ? "Nota en la página" : "Apunte") : annotationLabel(mark.type)}`);
      if (mark.type !== "sticky") lines.push(mark.text ? `> ${mark.text}` : "> Fragmento sin texto disponible");
      if (mark.note) lines.push("", mark.note);
      if (mark.ink?.strokes?.length) lines.push("", "_(incluye escritura a mano)_");
      lines.push("");
    }
  }
  downloadText(
    `${currentBook.name.replace(/\.pdf$/i, "")}-anotaciones.md`,
    lines.join("\n"),
    "text/markdown",
  );
  toast("Markdown exportado");
}

const SUPPORTED_ANNOTATION_TYPES = new Set(["highlight", "underline", "wavy", "strike", "note", "sticky", "pen", "box", "arrow"]);
const ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "orange", "purple", "red"];
function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value)));
}
function normalizeAnnotationRect(rect) {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return null;
  const x = clampUnit(rect.x), y = clampUnit(rect.y);
  const w = Math.max(0, Math.min(1 - x, Number(rect.w)));
  const h = Math.max(0, Math.min(1 - y, Number(rect.h)));
  return w > 0.0005 && h > 0.0005 ? { x, y, w, h } : null;
}
function normalizeAnnotationPoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: clampUnit(point.x), y: clampUnit(point.y) };
}
// Valida trazos de escritura a mano importados (colores y puntos acotados).
function sanitizeInk(ink) {
  const strokes = Array.isArray(ink?.strokes) ? ink.strokes : [];
  return {
    h: Math.max(0.2, Math.min(6, Number(ink?.h) || NOTE_INK_DEFAULT_RATIO)),
    strokes: strokes.slice(0, 2000).map((stroke) => ({
      t: stroke?.t === "highlight" ? "highlight" : "pen",
      c: /^#[0-9a-f]{6}$/i.test(stroke?.c) ? stroke.c : NOTE_INK_COLORS.black,
      w: Math.max(0.5, Math.min(40, Number(stroke?.w) || 2.6)),
      p: (Array.isArray(stroke?.p) ? stroke.p : []).slice(0, 5000).map((point) => [Number(point?.[0]) || 0, Number(point?.[1]) || 0, Math.max(0, Math.min(1, Number(point?.[2]) || 0))]),
    })).filter((stroke) => stroke.p.length),
  };
}
function normalizeImportedAnnotation(mark) {
  if (!mark || !SUPPORTED_ANNOTATION_TYPES.has(mark.type)) return null;
  const page = Math.trunc(Number(mark.page));
  if (!pdfDoc || page < 1 || page > pdfDoc.numPages) return null;
  if (mark.type === "sticky") {
    const pinned = mark.x !== null && mark.x !== undefined && mark.y !== null && mark.y !== undefined;
    const x = Number(mark.x),
      y = Number(mark.y);
    if (pinned && !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const ink = sanitizeInk(mark.ink);
    return {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      page,
      type: "sticky",
      color: ANNOTATION_COLORS.includes(mark.color) ? mark.color : "yellow",
      x: pinned ? x : null,
      y: pinned ? y : null,
      note: String(mark.note || "").slice(0, 20000),
      ...(ink.strokes.length ? { ink } : {}),
      text: "",
      rects: [],
      createdAt: Number(mark.createdAt) || Date.now(),
    };
  }
  const rects = Array.isArray(mark.rects) ? mark.rects.map(normalizeAnnotationRect).filter(Boolean) : [];
  const points = Array.isArray(mark.points) ? mark.points.map(normalizeAnnotationPoint).filter(Boolean) : [];
  if (!rects.length && points.length < 2) return null;
  return {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page,
    type: mark.type,
    color: ANNOTATION_COLORS.includes(mark.color) ? mark.color : "yellow",
    opacity: Math.max(.1, Math.min(1, Number(mark.opacity) || .48)),
    width: Math.max(1, Math.min(12, Number(mark.width) || 2)),
    text: String(mark.text || "").slice(0, 1000),
    note: String(mark.note || "").slice(0, 2000),
    rects,
    ...(points.length >= 2 ? { points } : {}),
    sourceId: mark.sourceId ? String(mark.sourceId) : undefined,
    createdAt: Number(mark.createdAt) || Date.now(),
  };
}
// Fusiona las notas del cuaderno de una copia de seguridad sin pisar las
// existentes: si una página ya tiene texto, el importado se añade debajo.
function importNotebookBackup(data) {
  let count = 0;
  if (data?.pageNotes && typeof data.pageNotes === "object") {
    const store = pageNotesStore();
    for (const [pageKey, entry] of Object.entries(data.pageNotes)) {
      const page = Math.trunc(Number(pageKey));
      const text = String(entry?.text ?? entry ?? "").trim();
      if (!text || !pdfDoc || page < 1 || page > pdfDoc.numPages) continue;
      const existing = store[page]?.text?.trim();
      if (existing === text) continue;
      store[page] = { text: existing ? `${existing}\n\n${text}` : text, updatedAt: Date.now() };
      count++;
    }
    setJSON(key(currentBook.id, "page-notes"), store);
  }
  const docText = String(data?.documentNote || "").trim();
  if (docText && docText !== documentNote().trim()) {
    const existing = documentNote().trim();
    writeDocumentNote(existing ? `${existing}\n\n${docText}` : docText);
    count++;
  }
  const docInk = data?.documentNoteInk;
  if (docInk && Array.isArray(docInk.strokes) && docInk.strokes.length) {
    const current = documentNoteInk() || { h: NOTE_INK_DEFAULT_RATIO, strokes: [] };
    setJSON(key(currentBook.id, "doc-note-ink"), { h: Math.max(current.h || 0, Number(docInk.h) || NOTE_INK_DEFAULT_RATIO), strokes: [...current.strokes, ...sanitizeInk(docInk).strokes] });
    count++;
  }
  migrateLegacyPageNotes();
  if (count && !$("notebookPanel").hidden) renderNotebook();
  return count;
}
async function importAnnotationBackup(file) {
  if (!currentBook || !pdfDoc) return toast("Abre el PDF de destino primero");
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data?.annotations)) throw new Error("Formato no compatible");
    const imported = data.annotations.map(normalizeImportedAnnotation).filter(Boolean);
    const notesImported = importNotebookBackup(data);
    if (!imported.length && !notesImported) throw new Error("No contiene anotaciones compatibles");
    if (imported.length) commitAnnotations([...annotations(), ...imported]);
    renderAnnotations();
    renderAnnotationList();
    toast(`${imported.length} anotación${imported.length === 1 ? " importada" : "es importadas"}${notesImported ? ` · ${notesImported} nota${notesImported === 1 ? "" : "s"} del cuaderno` : ""}`);
  } catch (error) {
    console.error("No se pudieron importar las anotaciones", error);
    toast("El archivo de anotaciones no es válido");
  }
}
function nearestAnnotationColor(rgb) {
  const palette = {
    yellow: [255, 193, 7], green: [46, 160, 88], blue: [47, 112, 224], pink: [229, 72, 134],
    orange: [239, 123, 38], purple: [137, 74, 204], red: [218, 64, 64],
  };
  const values = Array.from(rgb || []);
  if (values.length < 3) return "yellow";
  const normalized = values.slice(0, 3).map((value) => value <= 1 ? value * 255 : value);
  return Object.entries(palette).sort(([, a], [, b]) =>
    a.reduce((sum, value, index) => sum + (value - normalized[index]) ** 2, 0) -
    b.reduce((sum, value, index) => sum + (value - normalized[index]) ** 2, 0),
  )[0][0];
}
function pdfRectToNormalized(rect, viewport) {
  if (!Array.isArray(rect) && !(rect instanceof Float32Array)) return null;
  const converted = viewport.convertToViewportRectangle(Array.from(rect));
  const left = Math.min(converted[0], converted[2]), top = Math.min(converted[1], converted[3]);
  return normalizeAnnotationRect({
    x: left / viewport.width,
    y: top / viewport.height,
    w: Math.abs(converted[2] - converted[0]) / viewport.width,
    h: Math.abs(converted[3] - converted[1]) / viewport.height,
  });
}
function pdfQuadRects(quadPoints, viewport) {
  const raw = Array.from(quadPoints || []);
  if (!raw.length) return [];
  const coordinates = typeof raw[0] === "object"
    ? raw.flatMap((point) => [point.x, point.y])
    : raw;
  const rects = [];
  for (let index = 0; index + 7 < coordinates.length; index += 8) {
    const points = [];
    for (let offset = 0; offset < 8; offset += 2)
      points.push(viewport.convertToViewportPoint(coordinates[index + offset], coordinates[index + offset + 1]));
    const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
    const rect = normalizeAnnotationRect({
      x: Math.min(...xs) / viewport.width,
      y: Math.min(...ys) / viewport.height,
      w: (Math.max(...xs) - Math.min(...xs)) / viewport.width,
      h: (Math.max(...ys) - Math.min(...ys)) / viewport.height,
    });
    if (rect) rects.push(rect);
  }
  return rects;
}
async function importEmbeddedPdfAnnotations() {
  if (!pdfDoc || !currentBook || currentBook.kind === "markdown") return toast("Abre un PDF primero");
  const existingSources = new Set(annotations().map((mark) => mark.sourceId).filter(Boolean));
  const imported = [];
  showLoader(true, "Importando anotaciones…", "Analizando el documento");
  try {
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      $("loaderText").textContent = `Página ${pageNumber} de ${pdfDoc.numPages}`;
      const page = await getCachedPage(pageNumber);
      const viewport = page.getViewport({ scale: 1, rotation });
      const embedded = await page.getAnnotations({ intent: "display" });
      embedded.forEach((annotation, annotationIndex) => {
        const type = ({ Highlight: "highlight", Underline: "underline", Squiggly: "wavy", StrikeOut: "strike", Text: "note", Ink: "pen" })[annotation.subtype];
        if (!type) return;
        const baseSource = `pdf:${pageNumber}:${annotation.id || annotationIndex}`;
        const color = nearestAnnotationColor(annotation.color);
        const note = annotation.contentsObj?.str || annotation.contents || "";
        if (type === "pen" && Array.isArray(annotation.inkLists)) {
          annotation.inkLists.forEach((stroke, strokeIndex) => {
            const sourceId = `${baseSource}:${strokeIndex}`;
            if (existingSources.has(sourceId)) return;
            const rawStroke = Array.from(stroke || []);
            const sourcePoints = typeof rawStroke[0] === "number"
              ? Array.from({ length: Math.floor(rawStroke.length / 2) }, (_, index) => [rawStroke[index * 2], rawStroke[index * 2 + 1]])
              : rawStroke;
            const points = sourcePoints.map((point) => {
              const x = Array.isArray(point) ? point[0] : point?.x;
              const y = Array.isArray(point) ? point[1] : point?.y;
              if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
              const converted = viewport.convertToViewportPoint(x, y);
              return normalizeAnnotationPoint({ x: converted[0] / viewport.width, y: converted[1] / viewport.height });
            }).filter(Boolean);
            if (points.length < 2) return;
            imported.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, page: pageNumber, type, color, opacity: annotation.opacity || .82, width: annotation.borderStyle?.width || 2, text: "", note: String(note).slice(0, 2000), rects: [], points, sourceId, createdAt: Date.now() });
            existingSources.add(sourceId);
          });
          return;
        }
        const sourceId = baseSource;
        if (existingSources.has(sourceId)) return;
        const rects = pdfQuadRects(annotation.quadPoints, viewport);
        const fallbackRect = pdfRectToNormalized(annotation.rect, viewport);
        if (!rects.length && fallbackRect) rects.push(fallbackRect);
        if (!rects.length) return;
        imported.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, page: pageNumber, type, color, opacity: annotation.opacity || .48, width: annotation.borderStyle?.width || 2, text: "", note: String(note).slice(0, 2000), rects, sourceId, createdAt: Date.now() });
        existingSources.add(sourceId);
      });
      if (pageNumber % 12 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!imported.length) return toast("No se encontraron anotaciones nuevas en el PDF");
    commitAnnotations([...annotations(), ...imported]);
    renderAnnotations();
    renderAnnotationList();
    toast(`${imported.length} anotación${imported.length === 1 ? " importada" : "es importadas"} desde el PDF`);
  } catch (error) {
    console.error("No se pudieron importar las anotaciones del PDF", error);
    toast("No se pudieron importar las anotaciones del PDF");
  } finally {
    showLoader(false);
  }
}

function annotations() {
  return currentBook ? getJSON(key(currentBook.id, "annotations"), []) : [];
}
function setAnnotations(items) {
  if (currentBook) setJSON(key(currentBook.id, "annotations"), items);
}
function resetAnnotationHistory() {
  annotationUndo = [];
  annotationRedo = [];
  annotationSelectMode = false;
  selectedAnnotationId = null;
  document.body.classList.remove("annotation-select-mode");
  $("annotationEditor").hidden = true;
  $("inkStrip")?.querySelector("[data-strip-select]")?.classList.remove("active");
}
function commitAnnotations(items, record = true) {
  if (!currentBook) return;
  if (record) {
    annotationUndo.push(structuredClone(annotations()));
    if (annotationUndo.length > 50) annotationUndo.shift();
    annotationRedo = [];
  }
  setAnnotations(items);
}
function annotationStyle(color, opacity) {
  const rgb = {
    yellow: "255,193,7",
    green: "46,160,88",
    pink: "229,72,134",
    blue: "47,112,224",
    orange: "239,123,38",
    purple: "137,74,204",
    red: "218,64,64",
  }[color] || "255,193,7";
  const alpha = Number.isFinite(opacity) ? opacity : 0.48;
  return `rgba(${rgb},${alpha})`;
}
function annotationLabel(type) {
  if (type === "sticky") return "Nota";
  return type === "note"
    ? "Nota"
    : type === "pen"
      ? "Trazo libre"
      : type === "box"
        ? "Recuadro"
        : type === "arrow"
          ? "Flecha"
    : type === "underline"
      ? "Subrayado"
      : type === "wavy"
        ? "Subrayado ondulado"
        : type === "strike"
          ? "Tachado"
          : "Resaltado";
}
function closeAnnotationEditor() {
  const hadSelection = Boolean(selectedAnnotationId);
  selectedAnnotationId = null;
  $("annotationEditor").hidden = true;
  if (hadSelection) {
    renderAnnotations();
    renderAnnotationList();
  }
}
function setAnnotationSelectMode(force) {
  const next = typeof force === "boolean" ? force : !annotationSelectMode;
  if (next && markerMode) toggleMarkerMode();
  if (next && eraserMode) toggleEraserMode(false);
  annotationSelectMode = next;
  document.body.classList.toggle("annotation-select-mode", annotationSelectMode);
  $("inkStrip")?.querySelector("[data-strip-select]")?.classList.toggle("active", annotationSelectMode);
  if (!annotationSelectMode) closeAnnotationEditor();
  toast(annotationSelectMode ? "Selecciona una anotación para editarla" : "Edición de anotaciones desactivada");
}
function updateAnnotation(id, patch, record = true) {
  const items = annotations();
  const index = items.findIndex((mark) => mark.id === id);
  if (index < 0) return false;
  const changed = Object.entries(patch).some(([property, value]) =>
    JSON.stringify(items[index][property] ?? null) !== JSON.stringify(value ?? null),
  );
  if (!changed) return false;
  items[index] = { ...items[index], ...patch, updatedAt: Date.now() };
  commitAnnotations(items, record);
  renderAnnotations();
  renderAnnotationList();
  return true;
}
function deleteAnnotation(id) {
  const mark = annotations().find((item) => item.id === id);
  if (!mark) return;
  commitAnnotations(annotations().filter((item) => item.id !== id));
  closeAnnotationEditor();
  toast("Anotación eliminada");
}
function openAnnotationEditor(id, anchorRect = null) {
  const mark = annotations().find((item) => item.id === id);
  if (!mark) return;
  if (!annotationSelectMode) setAnnotationSelectMode(true);
  selectedAnnotationId = id;
  renderAnnotations();
  renderAnnotationList();
  const editor = $("annotationEditor");
  const colors = ["yellow", "green", "blue", "pink", "orange", "purple", "red"];
  const textTypes = ["highlight", "underline", "wavy", "strike"];
  const editableType = textTypes.includes(mark.type);
  editor.innerHTML = `<header><div><small>Página ${mark.page}</small><strong>${annotationLabel(mark.type)}</strong></div><button class="btn icon" data-editor-close aria-label="Cerrar editor">×</button></header>${editableType ? `<label>Tipo<select class="field" data-editor-type>${textTypes.map((type) => `<option value="${type}"${type === mark.type ? " selected" : ""}>${annotationLabel(type)}</option>`).join("")}</select></label>` : ""}<label>Color<div class="annotation-editor-colors">${colors.map((color) => `<button data-editor-color="${color}" class="${color === (mark.color || "yellow") ? "active" : ""}" style="--swatch:${annotationStyle(color, .9)}" aria-label="${color}"></button>`).join("")}</div></label><label>Opacidad <output data-opacity-output>${Math.round((mark.opacity ?? .48) * 100)}%</output><input type="range" min="10" max="100" value="${Math.round((mark.opacity ?? .48) * 100)}" data-editor-opacity></label>${mark.type !== "highlight" && mark.type !== "note" ? `<label>Grosor <output data-width-output>${mark.width || 2}px</output><input type="range" min="1" max="12" value="${mark.width || 2}" data-editor-width></label>` : ""}<label>Comentario<textarea class="field" data-editor-note placeholder="Añade una nota a esta anotación…">${escapeHtml(mark.note || "")}</textarea></label><footer><button class="btn" data-editor-duplicate>Duplicar</button><button class="btn danger" data-editor-delete>Eliminar</button></footer>`;
  editor.hidden = false;
  const width = 310;
  const left = anchorRect ? anchorRect.right + 10 : window.innerWidth - width - 18;
  const top = anchorRect ? anchorRect.top : 84;
  editor.style.left = `${Math.max(10, Math.min(left, window.innerWidth - width - 10))}px`;
  editor.style.top = `${Math.max(64, Math.min(top, window.innerHeight - editor.offsetHeight - 10))}px`;
  editor.querySelector("[data-editor-close]").onclick = closeAnnotationEditor;
  editor.querySelector("[data-editor-delete]").onclick = () => deleteAnnotation(id);
  editor.querySelector("[data-editor-duplicate]").onclick = () => {
    const items = annotations();
    const copy = structuredClone(items.find((item) => item.id === id));
    if (!copy) return;
    copy.id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    copy.createdAt = Date.now();
    delete copy.sourceId;
    items.push(copy);
    commitAnnotations(items);
    renderAnnotations();
    renderAnnotationList();
    toast("Anotación duplicada");
  };
  editor.querySelector("[data-editor-type]")?.addEventListener("change", (event) => {
    if (updateAnnotation(id, { type: event.target.value })) openAnnotationEditor(id, anchorRect);
  });
  editor.querySelectorAll("[data-editor-color]").forEach((button) => button.onclick = () => {
    updateAnnotation(id, { color: button.dataset.editorColor });
    openAnnotationEditor(id, anchorRect);
  });
  const opacity = editor.querySelector("[data-editor-opacity]");
  opacity.oninput = () => {
    editor.querySelector("[data-opacity-output]").textContent = `${opacity.value}%`;
  };
  opacity.onchange = () => updateAnnotation(id, { opacity: Number(opacity.value) / 100 });
  const widthInput = editor.querySelector("[data-editor-width]");
  if (widthInput) {
    widthInput.oninput = () => editor.querySelector("[data-width-output]").textContent = `${widthInput.value}px`;
    widthInput.onchange = () => updateAnnotation(id, { width: Number(widthInput.value) });
  }
  editor.querySelector("[data-editor-note]").onchange = (event) => updateAnnotation(id, { note: event.target.value.trim().slice(0, 2000) });
}
function renderAnnotations() {
  const layer = $("annotationLayer");
  layer.innerHTML = "";
  if (!currentBook) return;
  for (const mark of annotations().filter((a) => a.page === currentPage)) {
    if (mark.type === "sticky") continue;
    if ((mark.type === "pen" || mark.type === "arrow") && mark.points?.length) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 1 1");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.classList.add("annotation-vector");
      svg.classList.toggle("selected", mark.id === selectedAnnotationId);
      svg.dataset.annotationId = mark.id;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", mark.points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", annotationStyle(mark.color, mark.opacity ?? 0.82));
      path.setAttribute("stroke-width", String(mark.width || 3));
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.dataset.annotationId = mark.id;
      path.classList.toggle("selected", mark.id === selectedAnnotationId);
      const arrowId = `ink-arrow-${String(mark.id).replace(/[^a-z0-9_-]/gi, "")}`;
      if (mark.type === "arrow") path.setAttribute("marker-end", `url(#${arrowId})`);
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `<marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="${annotationStyle(mark.color, mark.opacity ?? 0.82)}"></path></marker>`;
      svg.append(defs, path);
      layer.appendChild(svg);
      continue;
    }
    for (const rect of mark.rects) {
      const el = document.createElement("i");
      el.className = `annotation ${mark.type}`;
      el.classList.toggle("selected", mark.id === selectedAnnotationId);
      el.dataset.annotationId = mark.id;
      el.style.left = `${rect.x * 100}%`;
      el.style.top = `${rect.y * 100}%`;
      el.style.width = `${rect.w * 100}%`;
      el.style.height = `${rect.h * 100}%`;
      el.style.setProperty("--ink-color", annotationStyle(mark.color, mark.opacity));
      el.style.setProperty("--ink-width", `${mark.width || 2}px`);
      if (mark.type === "underline" || mark.type === "wavy")
        el.style.top = `calc(${(rect.y + rect.h) * 100}% - 3px)`;
      if (mark.type === "highlight")
        el.style.background = annotationStyle(mark.color, mark.opacity);
      layer.appendChild(el);
    }
  }
  renderStickyNotes();
}
function renderAnnotationList() {
  const list = $("annotationList");
  document
    .querySelectorAll("[data-annotation-filter]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.annotationFilter === annotationFilter,
      ),
    );
  if (!currentBook) {
    list.innerHTML = "";
    return;
  }
  const all = annotations().sort(
      (a, b) => a.page - b.page || b.createdAt - a.createdAt,
    ),
    marks =
      annotationFilter === "all"
        ? all
        : annotationFilter === "drawing"
          ? all.filter((mark) => ["pen", "box", "arrow"].includes(mark.type))
          : annotationFilter === "note"
            ? all.filter((mark) => mark.type === "note" || mark.type === "sticky")
            : all.filter((mark) => mark.type === annotationFilter);
  list.innerHTML = marks.length
    ? marks
        .map(
          (mark) =>
            `<div class="annotation-entry${mark.id === selectedAnnotationId ? " selected" : ""}"><button class="bookmark" data-annotation-page="${mark.page}" data-annotation-id="${mark.id}"><strong>${annotationLabel(mark.type)} · página ${mark.page}</strong><small>${escapeHtml(mark.note || mark.text || "Fragmento seleccionado")}</small></button><button class="btn icon annotation-remove" data-remove-annotation="${mark.id}" aria-label="Eliminar anotación">×</button></div>`,
        )
        .join("")
    : `<span style="color:var(--muted);font-size:13px">${all.length ? "No hay anotaciones de este tipo." : "Aún no hay anotaciones."}</span>`;
  document
    .querySelectorAll("[data-annotation-page]")
    .forEach(
      (button) =>
        (button.onclick = async () => {
          await jumpToPage(Number(button.dataset.annotationPage));
          const mark = annotations().find((item) => item.id === button.dataset.annotationId);
          if (mark?.type === "sticky") openStickyEditor(mark.id);
          else openAnnotationEditor(button.dataset.annotationId);
        }),
    );
  document.querySelectorAll("[data-remove-annotation]").forEach(
    (button) =>
      (button.onclick = () => {
        deleteAnnotation(button.dataset.removeAnnotation);
      }),
  );
  updateThumbNoteBadges();
  if (!suppressNotebookRender && !$("notebookPanel").hidden && !$("notebookPanel").contains(document.activeElement)) renderNotebook();
}
function selectedRects() {
  const sel = window.getSelection(),
    layer = $("textLayer");
  if (
    !sel?.rangeCount ||
    sel.isCollapsed ||
    !layer.contains(sel.anchorNode) ||
    !layer.contains(sel.focusNode)
  )
    return null;
  const pageBox = $("canvasWrap").getBoundingClientRect();
  const rects = [...sel.getRangeAt(0).getClientRects()]
    .map((r) => ({
      x: (r.left - pageBox.left) / pageBox.width,
      y: (r.top - pageBox.top) / pageBox.height,
      w: r.width / pageBox.width,
      h: r.height / pageBox.height,
    }))
    .filter((r) => r.w > 0 && r.h > 0 && r.x >= -0.02 && r.y >= -0.02);
  return rects.length ? rects : null;
}
function hideAnnotationActions() {
  $("annotationActions").classList.remove("show");
}
async function copySelectionText() {
  const text = window.getSelection()?.toString().trim();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    toast("Texto copiado");
  } catch {
    toast("No se pudo copiar");
  }
  hideAnnotationActions();
}
function paintLiveHighlight() {
  const layer = $("liveHighlightLayer"),
    rects = selectedRects();
  layer.innerHTML = "";
  if (!markerMode || !rects) return;
  for (const rect of rects) {
    const el = document.createElement("i");
    el.className = `live-highlight ${inkTool}`;
    el.style.left = `${rect.x * 100}%`;
    el.style.top = `${rect.y * 100}%`;
    el.style.width = `${rect.w * 100}%`;
    el.style.height = `${rect.h * 100}%`;
    el.style.setProperty("--ink-color", annotationStyle(annotationColor));
    if (inkTool === "underline" || inkTool === "wavy")
      el.style.top = `calc(${(rect.y + rect.h) * 100}% - 3px)`;
    layer.appendChild(el);
  }
}
function clearLiveHighlight() {
  $("liveHighlightLayer").innerHTML = "";
}
function isDrawingTool(tool = inkTool) {
  return tool === "pen" || tool === "box" || tool === "arrow";
}
function syncInkInteractionMode() {
  document.body.classList.toggle("ink-drawing-mode", markerMode && isDrawingTool());
  document.body.classList.toggle("ink-eraser-mode", eraserMode);
  $("inkDrawingLayer").style.setProperty("--draw-color", annotationStyle(annotationColor, inkOpacity));
  $("inkDrawingLayer").style.setProperty("--draw-width", String(inkWidth));
}
function pageInkPoint(event) {
  const box = $("canvasWrap").getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
    y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
  };
}
function paintLiveStroke() {
  const layer = $("inkDrawingLayer");
  layer.replaceChildren();
  if (!inkStroke) return;
  const color = annotationStyle(annotationColor, inkOpacity);
  if (inkStroke.type === "box") {
    const [start, end] = inkStroke.points;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(Math.min(start.x, end.x)));
    rect.setAttribute("y", String(Math.min(start.y, end.y)));
    rect.setAttribute("width", String(Math.abs(end.x - start.x)));
    rect.setAttribute("height", String(Math.abs(end.y - start.y)));
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-width", String(inkWidth));
    rect.setAttribute("vector-effect", "non-scaling-stroke");
    rect.setAttribute("rx", ".006");
    layer.append(rect);
    return;
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", inkStroke.points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", String(inkWidth));
  path.setAttribute("vector-effect", "non-scaling-stroke");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (inkStroke.type === "arrow") {
    const end = inkStroke.points.at(-1), previous = inkStroke.points.at(-2) || inkStroke.points[0];
    const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
    const size = 0.018;
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", `M${end.x} ${end.y} L${end.x - Math.cos(angle - .55) * size} ${end.y - Math.sin(angle - .55) * size} M${end.x} ${end.y} L${end.x - Math.cos(angle + .55) * size} ${end.y - Math.sin(angle + .55) * size}`);
    arrow.setAttribute("fill", "none");
    arrow.setAttribute("stroke", color);
    arrow.setAttribute("stroke-width", String(inkWidth));
    arrow.setAttribute("vector-effect", "non-scaling-stroke");
    layer.append(path, arrow);
    return;
  }
  layer.append(path);
}
function saveInkStroke() {
  if (!inkStroke || !currentBook) return;
  const points = inkStroke.points;
  const distance = Math.hypot(points.at(-1).x - points[0].x, points.at(-1).y - points[0].y);
  if (points.length < 2 || distance < 0.004) {
    inkStroke = null;
    paintLiveStroke();
    return;
  }
  const mark = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page: currentPage,
    type: inkStroke.type,
    color: annotationColor,
    opacity: inkOpacity,
    width: inkWidth,
    createdAt: Date.now(),
    text: "",
  };
  if (inkStroke.type === "box") {
    const [start, end] = points;
    mark.rects = [{ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }];
  } else {
    mark.points = inkStroke.type === "arrow" ? [points[0], points.at(-1)] : points;
    mark.rects = [];
  }
  const items = annotations();
  items.push(mark);
  commitAnnotations(items);
  inkStroke = null;
  paintLiveStroke();
  renderAnnotations();
  renderAnnotationList();
  toast(mark.type === "pen" ? "Trazo guardado" : mark.type === "box" ? "Recuadro guardado" : "Flecha guardada");
}
function showAnnotationActions() {
  const rects = selectedRects();
  if (!rects || markerMode || eraserMode) {
    hideAnnotationActions();
    return;
  }
  const r = window.getSelection().getRangeAt(0).getBoundingClientRect(),
    actions = $("annotationActions"),
    width = 240;
  actions.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, r.left + r.width / 2 - width / 2))}px`;
  actions.style.top = `${r.top > 62 ? r.top - 45 : r.bottom + 8}px`;
  actions.classList.add("show");
}
function saveAnnotation(type, quiet = false) {
  const rects = selectedRects(),
    text = window.getSelection()?.toString().trim();
  if (!rects || !currentBook) return false;
  const items = annotations();
  items.push({
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page: currentPage,
    type,
    color: annotationColor,
    opacity: inkOpacity,
    text: text?.slice(0, 500) || "",
    rects,
    createdAt: Date.now(),
  });
  commitAnnotations(items);
  window.getSelection().removeAllRanges();
  hideAnnotationActions();
  clearLiveHighlight();
  renderAnnotations();
  renderAnnotationList();
  if (!quiet)
    toast(
      type === "highlight"
        ? "Texto resaltado"
        : type === "strike"
          ? "Texto tachado"
          : type === "wavy"
            ? "Subrayado ondulado aplicado"
            : "Texto subrayado",
    );
  return true;
}
function toggleMarkerMode() {
  if (annotationSelectMode) setAnnotationSelectMode(false);
  if (eraserMode) toggleEraserMode(false);
  markerMode = !markerMode;
  document.body.classList.toggle("marker-mode", markerMode);
  $("markerModeBtn").classList.toggle("active", markerMode);
  $("markerModeBtn").setAttribute("aria-pressed", String(markerMode));
  if (!markerMode) clearLiveHighlight();
  syncInkInteractionMode();
  const toolLabels = { highlight: "Marcador", underline: "Subrayador", wavy: "Subrayador ondulado", strike: "Tachado", pen: "Pluma", box: "Recuadro", arrow: "Flecha" };
  toast(
    markerMode
      ? `${toolLabels[inkTool] || "Ink"} activado: ${isDrawingTool() ? "dibuja directamente sobre la página." : "selecciona texto y suelta."}`
      : "Rotulador directo desactivado",
  );
}
function setInkTool(tool) {
  inkTool = tool;
  applyInkToolStyle(tool);
  document
    .querySelectorAll("[data-ink-tool]")
    .forEach((button) => button.classList.toggle("active", button.dataset.inkTool === tool));
  const label = INK_TOOL_LABELS[tool] || "Ink";
  $("markerModeBtn").title = `Herramientas Ink · ${label}`;
  $("markerModeBtn").setAttribute("aria-label", $("markerModeBtn").title);
  if (markerMode) toast(`${label} seleccionado`);
  refreshInkPreview();
  paintLiveHighlight();
  syncInkInteractionMode();
}
function refreshInkPreview() {
  const preview = $("inkPreview");
  if (!preview) return;
  const color = annotationStyle(annotationColor);
  preview.className = `ink-preview ${inkTool}`;
  preview.style.setProperty("--ink-preview", color);
}
function undoAnnotation() {
  if (!currentBook) return;
  const previous = annotationUndo.pop();
  if (!previous) return toast("No hay cambios que deshacer");
  annotationRedo.push(structuredClone(annotations()));
  setAnnotations(previous);
  closeAnnotationEditor();
  renderAnnotations();
  renderAnnotationList();
  toast("Cambio deshecho");
}
function redoAnnotation() {
  const next = annotationRedo.pop();
  if (!next) return toast("No hay cambios que rehacer");
  annotationUndo.push(structuredClone(annotations()));
  setAnnotations(next);
  closeAnnotationEditor();
  renderAnnotations();
  renderAnnotationList();
  toast("Cambio rehecho");
}
function buildInkPalette() {
  const popover = $("toolPopover");
  if (!popover || $("inkPreview")) return;
  const preview = document.createElement("div");
  preview.id = "inkPreview";
  preview.className = "ink-preview";
  preview.innerHTML = "<i></i>";
  popover.querySelector("p")?.insertAdjacentElement("afterend", preview);
  const icons = { highlight: "▰", underline: "U̲", strike: "S̶" };
  popover.querySelectorAll("[data-ink-tool]").forEach((button) => {
    button.innerHTML = `<b>${icons[button.dataset.inkTool]}</b><span>${button.textContent}</span>`;
  });
  const eraser = document.createElement("button");
  eraser.className = "btn";
  eraser.id = "inkEraserTool";
  eraser.innerHTML = "<b>⌫</b><span>Goma</span>";
  popover.querySelector(".tool-row")?.append(eraser);
  eraser.onclick = () => {
    toggleEraserMode();
    popover.classList.remove("open");
  };
  if (!$("inkStrip")) {
    const strip = document.createElement("div");
    strip.className = "ink-strip";
    strip.id = "inkStrip";
    strip.dataset.activeTool = "Marcador";
    strip.hidden = true;
    const toolButton = (tool, icon, label) => `<button data-strip-tool="${tool}" title="${label}" aria-label="${label}">${iconSvg(icon)}<i class="tool-color"></i></button>`;
    strip.innerHTML = `<div class="ink-strip-inner"><button class="ink-drag-handle" data-strip-drag title="Mover la barra (doble clic para recolocarla)" aria-label="Mover barra Ink">${iconSvg("grip")}</button><span class="ink-sep"></span><button data-strip-select title="Seleccionar y editar anotaciones (S)" aria-label="Seleccionar anotación">${iconSvg("cursor")}</button><span class="ink-sep"></span>${toolButton("pen", "pen", "Pluma libre")}${toolButton("highlight", "highlighter", "Marcador de texto")}<span class="ink-sep"></span>${toolButton("underline", "underline", "Subrayado")}${toolButton("wavy", "wavy", "Subrayado ondulado")}${toolButton("strike", "strike", "Tachado")}<span class="ink-sep"></span>${toolButton("box", "square", "Recuadro")}${toolButton("arrow", "arrow", "Flecha")}<button data-strip-note title="Nota en un punto de la página (N)" aria-label="Añadir nota en la página">${iconSvg("sticky")}</button><span class="ink-sep"></span><button data-strip-eraser title="Goma: toca una anotación para borrarla" aria-label="Goma">${iconSvg("eraser")}</button><button data-strip-color title="Color y grosor de la herramienta" aria-label="Color y grosor"><i class="ink-dot"></i></button><span class="ink-sep"></span><button data-strip-undo title="Deshacer (Ctrl+Z)" aria-label="Deshacer">${iconSvg("back")}</button><button data-strip-redo title="Rehacer (Ctrl+Shift+Z)" aria-label="Rehacer">${iconSvg("forward")}</button><button data-strip-close title="Ocultar la barra Ink" aria-label="Ocultar la barra Ink">${iconSvg("close")}</button></div>`;
    $("openSidebar").closest(".toolbar").append(strip);
    const colors = ["yellow", "green", "blue", "pink", "orange", "purple", "red"];
    const colorCard = document.createElement("div");
    colorCard.className = "ink-color-card";
    colorCard.id = "inkColorCard";
    colorCard.hidden = true;
    colorCard.innerHTML = `<div class="ink-card-title">Estilo de tinta</div><div class="ink-color-preview"><i></i></div><span class="ink-control-label">Color sólido</span><div class="ink-color-list strong">${colors.map((color) => `<button data-strip-palette="${color}" data-strip-opacity=".88" style="background:${annotationStyle(color, .88)}" aria-label="${color}"></button>`).join("")}</div><span class="ink-control-label">Color translúcido</span><div class="ink-color-list soft">${colors.map((color) => `<button data-strip-palette="${color}" data-strip-opacity=".42" style="background:${annotationStyle(color, .42)}" aria-label="${color} suave"></button>`).join("")}</div><label class="ink-range-control"><span>Opacidad <output data-ink-opacity-output></output></span><input type="range" min="10" max="100" step="1" data-ink-opacity-range></label><span class="ink-control-label">Grosor del trazo</span><div class="ink-width-list"><button data-ink-width="1"><i></i><span>Fino</span></button><button data-ink-width="3"><i></i><span>Medio</span></button><button data-ink-width="6"><i></i><span>Grueso</span></button></div><label class="ink-range-control"><span>Grosor preciso <output data-ink-width-output></output></span><input type="range" min="1" max="12" step="1" data-ink-width-range></label>`;
    $("openSidebar").closest(".toolbar").append(colorCard);
    const dragHandle = strip.querySelector("[data-strip-drag]");
    let inkDrag = null;
    const clampInkPosition = (left, top) => {
      const width = strip.offsetWidth || Math.min(570, window.innerWidth - 16);
      const height = strip.offsetHeight || 48;
      return {
        left: Math.max(8, Math.min(left, Math.max(8, window.innerWidth - width - 8))),
        top: Math.max(8, Math.min(top, Math.max(8, window.innerHeight - height - 8))),
      };
    };
    const positionInkColorCard = (anchor = strip.querySelector(`[data-strip-tool="${inkTool}"]`)) => {
      if (colorCard.hidden || !anchor) {
        colorCard.classList.remove("ink-positioned");
        return;
      }
      const stripRect = strip.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const width = Math.min(430, window.innerWidth - 24);
      const height = colorCard.offsetHeight || 330;
      const left = Math.max(12, Math.min(anchorRect.left + anchorRect.width / 2 - width / 2, window.innerWidth - width - 12));
      let top = stripRect.bottom + 9;
      if (top + height > window.innerHeight - 12) top = Math.max(12, stripRect.top - height - 9);
      colorCard.style.setProperty("--ink-card-left", `${left}px`);
      colorCard.style.setProperty("--ink-card-top", `${top}px`);
      colorCard.classList.add("ink-positioned");
    };
    const setInkPosition = (left, top, persist = false) => {
      const next = clampInkPosition(left, top);
      strip.style.setProperty("--ink-left", `${next.left}px`);
      strip.style.setProperty("--ink-top", `${next.top}px`);
      strip.classList.add("ink-positioned");
      if (persist) localStorage.setItem("paper.ink-position", JSON.stringify(next));
      positionInkColorCard();
    };
    const resetInkPosition = () => {
      strip.classList.remove("ink-positioned");
      colorCard.classList.remove("ink-positioned");
      strip.style.removeProperty("--ink-left");
      strip.style.removeProperty("--ink-top");
      localStorage.removeItem("paper.ink-position");
    };
    dragHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = strip.getBoundingClientRect();
      inkDrag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      dragHandle.setPointerCapture(event.pointerId);
      strip.classList.add("ink-dragging");
    });
    dragHandle.addEventListener("pointermove", (event) => {
      if (!inkDrag || inkDrag.id !== event.pointerId) return;
      setInkPosition(event.clientX - inkDrag.dx, event.clientY - inkDrag.dy);
    });
    const finishInkDrag = (event) => {
      if (!inkDrag || inkDrag.id !== event.pointerId) return;
      const rect = strip.getBoundingClientRect();
      inkDrag = null;
      strip.classList.remove("ink-dragging");
      setInkPosition(rect.left, rect.top, true);
    };
    dragHandle.addEventListener("pointerup", finishInkDrag);
    dragHandle.addEventListener("pointercancel", finishInkDrag);
    dragHandle.addEventListener("dblclick", resetInkPosition);
    try {
      const saved = JSON.parse(localStorage.getItem("paper.ink-position") || "null");
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top))
        requestAnimationFrame(() => setInkPosition(saved.left, saved.top));
    } catch {
      localStorage.removeItem("paper.ink-position");
    }
    window.addEventListener("resize", () => {
      if (!strip.classList.contains("ink-positioned")) return;
      const rect = strip.getBoundingClientRect();
      setInkPosition(rect.left, rect.top);
    }, { passive: true });
    const updateStrip = () => {
      strip.style.setProperty("--ink-dot", annotationStyle(annotationColor, inkOpacity));
      strip.querySelector(".ink-dot").style.setProperty("--ink-dot", annotationStyle(annotationColor, inkOpacity));
      strip.querySelectorAll("[data-strip-tool]").forEach((button) => {
        const style = inkToolStyles[button.dataset.stripTool];
        const swatch = annotationStyle(style.color, style.opacity);
        button.style.setProperty("--tool-ink", swatch);
        button.style.setProperty("--ink-dot", swatch);
        button.classList.toggle("active", button.dataset.stripTool === inkTool && markerMode);
      });
      strip.dataset.activeTool = INK_TOOL_LABELS[inkTool] || "Ink";
    };
    const openToolStyle = (button, toggle = false) => {
      const wasOpen = !colorCard.hidden && colorCard.dataset.tool === inkTool;
      colorCard.dataset.tool = inkTool;
      colorCard.hidden = toggle && wasOpen;
      updateInkColorCard();
      requestAnimationFrame(() => positionInkColorCard(button));
    };
    strip.querySelectorAll("[data-strip-tool]").forEach((button) => (button.onclick = () => {
      const repeated = button.dataset.stripTool === inkTool && markerMode;
      setInkTool(button.dataset.stripTool);
      if (!markerMode) toggleMarkerMode();
      updateStrip();
      openToolStyle(button, repeated);
    }));
    strip.querySelector("[data-strip-select]").onclick = () => setAnnotationSelectMode();
    strip.querySelector("[data-strip-eraser]").onclick = () => { toggleEraserMode(); updateStrip(); };
    strip.querySelector("[data-strip-note]").onclick = () => setStickyPlacement(true);
    strip.querySelector("[data-strip-color]").onclick = () => {
      openToolStyle(strip.querySelector(`[data-strip-tool="${inkTool}"]`), true);
    };
    strip.querySelector("[data-strip-undo]").onclick = undoAnnotation;
    strip.querySelector("[data-strip-redo]").onclick = redoAnnotation;
    colorCard.querySelectorAll("[data-strip-palette]").forEach((button) => (button.onclick = () => { updateCurrentInkToolStyle({ color: button.dataset.stripPalette, opacity: Number(button.dataset.stripOpacity) }); refreshInkPreview(); updateStrip(); updateInkColorCard(); syncInkInteractionMode(); toast(`${INK_TOOL_LABELS[inkTool]} actualizado`); }));
    colorCard.querySelectorAll("[data-ink-width]").forEach((button) => (button.onclick = () => { updateCurrentInkToolStyle({ width: Number(button.dataset.inkWidth) }); updateStrip(); updateInkColorCard(); syncInkInteractionMode(); toast(`Trazo ${inkWidth === 1 ? "fino" : inkWidth === 3 ? "medio" : "grueso"}`); }));
    colorCard.querySelector("[data-ink-opacity-range]").oninput = (event) => { updateCurrentInkToolStyle({ opacity: Number(event.target.value) / 100 }); refreshInkPreview(); updateStrip(); updateInkColorCard(); syncInkInteractionMode(); };
    colorCard.querySelector("[data-ink-width-range]").oninput = (event) => { updateCurrentInkToolStyle({ width: Number(event.target.value) }); updateStrip(); updateInkColorCard(); syncInkInteractionMode(); };
    const updateInkColorCard = () => {
      colorCard.querySelector(".ink-card-title").textContent = `Estilo · ${INK_TOOL_LABELS[inkTool] || "Ink"}`;
      colorCard.querySelector(".ink-color-preview i").style.setProperty("--ink-card-color", annotationStyle(annotationColor, inkOpacity));
      colorCard.querySelector(".ink-color-preview i").style.height = `${Math.max(3, inkWidth * 2)}px`;
      colorCard.querySelectorAll("[data-strip-palette]").forEach((button) => button.classList.toggle("active", button.dataset.stripPalette === annotationColor && Number(button.dataset.stripOpacity) === inkOpacity));
      colorCard.querySelectorAll("[data-ink-width]").forEach((button) => button.classList.toggle("active", Number(button.dataset.inkWidth) === inkWidth));
      colorCard.querySelector("[data-ink-opacity-range]").value = String(Math.round(inkOpacity * 100));
      colorCard.querySelector("[data-ink-opacity-output]").textContent = `${Math.round(inkOpacity * 100)}%`;
      colorCard.querySelector("[data-ink-width-range]").value = String(inkWidth);
      colorCard.querySelector("[data-ink-width-output]").textContent = `${inkWidth}px`;
    };
    applyInkToolStyle();
    updateStrip();
    updateInkColorCard();
    strip.addEventListener("click", updateInkColorCard);
    strip.querySelector("[data-strip-close]").onclick = () => { strip.hidden = true; colorCard.hidden = true; document.body.classList.remove("ink-toolbar-open"); };
  }
  refreshInkPreview();
}
function selectionOverlaps(annotation, rects) {
  return annotation.rects.some((a) =>
    rects.some((b) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
    ),
  );
}
function eraseSelectedAnnotations(quiet = false) {
  const rects = selectedRects();
  if (!rects || !currentBook) return false;
  const all = annotations();
  const kept = all.filter(
    (annotation) => annotation.page !== currentPage || !selectionOverlaps(annotation, rects),
  );
  const erased = all.length - kept.length;
  if (!erased) return false;
  commitAnnotations(kept);
  window.getSelection().removeAllRanges();
  clearLiveHighlight();
  renderAnnotations();
  renderAnnotationList();
  if (!quiet) toast(`${erased} anotación${erased === 1 ? " eliminada" : "es eliminadas"}`);
  return true;
}
function toggleEraserMode(force) {
  eraserMode = typeof force === "boolean" ? force : !eraserMode;
  if (eraserMode && annotationSelectMode) setAnnotationSelectMode(false);
  if (eraserMode && markerMode) {
    markerMode = false;
    document.body.classList.remove("marker-mode");
    $("markerModeBtn").classList.remove("active");
    $("markerModeBtn").setAttribute("aria-pressed", "false");
  }
  $("eraserModeBtn").classList.toggle("active", eraserMode);
  $("eraserModeBtn").setAttribute("aria-pressed", String(eraserMode));
  syncInkInteractionMode();
  $("inkStrip")?.querySelector("[data-strip-eraser]")?.classList.toggle("active", eraserMode);
  if (eraserMode) toast("Goma activada: toca una anotación o selecciona texto marcado.");
}
function clearPageAnnotations() {
  if (!currentBook) return;
  const existing = annotations(),
    count = existing.filter((a) => a.page === currentPage).length;
  if (!count) return toast("No hay anotaciones en esta página");
  if (!confirm(`¿Eliminar las ${count} anotaciones de esta página?`)) return;
  commitAnnotations(existing.filter((a) => a.page !== currentPage));
  renderAnnotations();
  renderAnnotationList();
  $("toolPopover").classList.remove("open");
  toast("Anotaciones eliminadas");
}
function openNotePanel() {
  const rects = selectedRects(),
    text = window.getSelection()?.toString().trim();
  if (!rects || !text) return toast("Selecciona texto para añadir una nota");
  pendingNote = { rects, text: text.slice(0, 500) };
  $("noteQuote").textContent = pendingNote.text;
  $("noteText").value = "";
  $("notePanel").hidden = false;
  window.getSelection().removeAllRanges();
  hideAnnotationActions();
  $("noteText").focus();
}
function closeNotePanel() {
  pendingNote = null;
  $("notePanel").hidden = true;
}
function saveNote() {
  const note = $("noteText").value.trim();
  if (!pendingNote || !note || !currentBook) return;
  const items = annotations();
  items.push({
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page: currentPage,
    type: "note",
    text: pendingNote.text,
    note: note.slice(0, 1000),
    rects: pendingNote.rects,
    createdAt: Date.now(),
  });
  commitAnnotations(items);
  closeNotePanel();
  renderAnnotations();
  renderAnnotationList();
  toast("Nota guardada");
}
function closeCapture() {
  captureStart = null;
  $("captureOverlay").classList.remove("show");
  $("captureOverlay").setAttribute("aria-hidden", "true");
  $("captureBox").hidden = true;
}
async function openCapture() {
  if (!pdfDoc) return toast("Abre un PDF primero");
  if (reflowMode) await setReadingMode("pdf");
  closeCapture();
  $("captureOverlay").classList.add("show");
  $("captureOverlay").setAttribute("aria-hidden", "false");
  toast("Arrastra sobre una zona del PDF para recortarla");
}
function updateCaptureBox(a, b) {
  const box = $("captureBox"),
    left = Math.min(a.x, b.x),
    top = Math.min(a.y, b.y),
    width = Math.abs(b.x - a.x),
    height = Math.abs(b.y - a.y);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.hidden = false;
}
function cropPdfCapture(a, b) {
  const pageBox = $("canvasWrap").getBoundingClientRect(),
    left = Math.max(pageBox.left, Math.min(a.x, b.x)),
    top = Math.max(pageBox.top, Math.min(a.y, b.y)),
    right = Math.min(pageBox.right, Math.max(a.x, b.x)),
    bottom = Math.min(pageBox.bottom, Math.max(a.y, b.y));
  if (right - left < 20 || bottom - top < 20)
    return toast("Selecciona una zona más grande");
  const source = $("pdfCanvas"),
    sx = ((left - pageBox.left) * source.width) / pageBox.width,
    sy = ((top - pageBox.top) * source.height) / pageBox.height,
    sw = ((right - left) * source.width) / pageBox.width,
    sh = ((bottom - top) * source.height) / pageBox.height,
    out = document.createElement("canvas"),
    captureScale = Math.min(1, 1600 / Math.max(sw, sh));
  out.width = Math.max(1, Math.round(sw * captureScale));
  out.height = Math.max(1, Math.round(sh * captureScale));
  out
    .getContext("2d")
    .drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  aiImage = out.toDataURL("image/jpeg", 0.9);
  aiImagePage = currentPage;
  closeCapture();
  setAssistantButton(true);
  openAiAssistant(true);
}

const BUILTIN_AI_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["es"] }],
  expectedOutputs: [{ type: "text", languages: ["es"] }],
};
const BUILTIN_VISION_OPTIONS = {
  expectedInputs: [
    { type: "text", languages: ["es"] },
    { type: "image" },
  ],
  expectedOutputs: [{ type: "text", languages: ["es"] }],
  initialPrompts: [
    {
      role: "system",
      content:
        "Eres un asistente de lectura visual riguroso. Describe diagramas, texto, relaciones y detalles relevantes. Responde siempre en español y distingue claramente lo visible de tus inferencias.",
    },
  ],
};
function aiStatus(message) {
  const status = $("aiStatus");
  const raw = String(message || "");
  const percent = raw.match(/(\d{1,3})(?:\.\d+)?%/)?.[1];
  const loading = /fetching|loading|descarg|prepar|comprob|iniciando|pensando|analizando|cache/i.test(raw);
  let display = raw;
  if (/fetching param cache/i.test(raw))
    display = `Preparando el modelo local${percent ? ` · ${percent}%` : ""}`;
  else if (/loading model/i.test(raw))
    display = `Cargando el modelo local${percent ? ` · ${percent}%` : ""}`;
  status.textContent = display;
  status.classList.toggle("is-loading", loading);
  status.style.setProperty("--ai-progress", `${Math.min(100, Number(percent || 0))}%`);
  $("aiCard")?.classList.toggle("ai-busy", loading);
  $("aiCard")?.setAttribute("aria-busy", String(loading));
}
function setAssistantButton(active) {
  const button = $("captureBtn");
  button.classList.toggle("assistant-on", active);
  setIcon(button, "sparkles", active ? "Activo" : "Asistente");
}
function formatAiAnswer(text) {
  const escaped = escapeHtml(text).replace(
    /\*\*(.+?)\*\*/g,
    "<strong>$1</strong>",
  );
  const lines = escaped.split("\n");
  let html = "",
    inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h3>${line.replace(/^#{1,3}\s+/, "")}</h3>`;
      continue;
    }
    if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${line.replace(/^(?:[-*•]|\d+[.)])\s+/, "")}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    html += `<p>${line}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}
function renderAiAnswer() {
  const response = $("aiResponse");
  response.hidden = !aiAnswerRaw.trim();
  $("aiAnswer").innerHTML = formatAiAnswer(aiAnswerRaw);
}
function appendAiChunk(chunk) {
  aiAnswerRaw += chunk;
  renderAiAnswer();
}
async function streamBuiltInAnswer(session, prompt, signal) {
  let previous = "";
  for await (const chunk of session.promptStreaming(prompt, { signal })) {
    const value = String(chunk || "");
    const delta = previous && value.startsWith(previous) ? value.slice(previous.length) : value;
    appendAiChunk(delta);
    previous = value.startsWith(previous) ? value : `${previous}${value}`;
  }
}
const AI_STOP_WORDS = new Set("a al algo ante bajo con contra cual cuando de del desde donde el ella ellas ellos en entre era es esa ese eso esta este esto fue ha hay la las lo los más me mi muy no o para pero por porque que se si sin sobre su sus te tu un una y ya the of to in is it for on with as at by from or an be this that".split(" "));
function aiTokens(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]{3,}/g)
    ?.filter((token) => !AI_STOP_WORDS.has(token)) || [];
}
function chunkAiText(text, page, size = 1450, overlap = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(". ", end);
      if (boundary > start + size * .58) end = boundary + 1;
    }
    const content = normalized.slice(start, end).trim();
    if (content) chunks.push({ page, content, tokens: aiTokens(content) });
    if (end >= normalized.length) break;
  }
  return chunks;
}
function aiConversationKey() {
  return currentBook ? key(currentBook.id, "ai-conversation-v2") : "";
}
function saveAiConversation() {
  const storageKey = aiConversationKey();
  if (!storageKey) return;
  try {
    setJSON(storageKey, aiMessages.slice(-30));
  } catch {
    toast("No se pudo guardar la conversación local");
  }
}
function renderAiConversation() {
  const conversation = $("aiConversation");
  if (!conversation) return;
  conversation.hidden = !aiMessages.length;
  conversation.innerHTML = aiMessages.map((message) => {
    const sources = message.sources?.length
      ? `<small>${message.sources.map((page) => `p. ${page}`).join(" · ")}</small>`
      : "";
    return `<article class="ai-message ${message.role}"><header><strong>${message.role === "user" ? "Tú" : "Paper AI"}</strong>${sources}</header><div>${message.role === "assistant" ? formatAiAnswer(message.content) : `<p>${escapeHtml(message.content)}</p>`}</div></article>`;
  }).join("");
  conversation.scrollTop = conversation.scrollHeight;
}
function resetAiDocumentState() {
  documentContextIndex = null;
  documentContextIndexId = currentBook?.id || "";
  documentIndexLoading = null;
  aiSourcePages = [];
  aiMessages = currentBook ? getJSON(aiConversationKey(), []).filter((message) => message?.role && message?.content).slice(-30) : [];
  renderAiConversation();
}
function renderAiSources(pages = []) {
  aiSourcePages = [...new Set(pages)].sort((a, b) => a - b);
  const sources = $("aiSources");
  if (!sources) return;
  sources.hidden = !aiSourcePages.length;
  sources.innerHTML = aiSourcePages.map((page) => `<button type="button" data-ai-source-page="${page}">p. ${page}</button>`).join("");
  sources.querySelectorAll("[data-ai-source-page]").forEach((button) => {
    button.onclick = () => jumpToPage(Number(button.dataset.aiSourcePage));
  });
}
async function ensureDocumentContextIndex(signal) {
  if (!currentBook) return [];
  if (documentContextIndex && documentContextIndexId === currentBook.id) return documentContextIndex;
  if (documentIndexLoading && documentContextIndexId === currentBook.id) return documentIndexLoading;
  documentContextIndexId = currentBook.id;
  documentIndexLoading = (async () => {
    if (currentBook.kind === "markdown") return chunkAiText(markdownContent, 1);
    if (!pdfDoc) return [];
    const chunks = [];
    const order = [currentPage, ...Array.from({ length: pdfDoc.numPages }, (_, index) => index + 1).filter((page) => page !== currentPage)];
    for (let index = 0; index < order.length; index++) {
      signal?.throwIfAborted?.();
      const pageNumber = order[index];
      aiStatus(`Preparando contexto local · página ${index + 1} de ${order.length}`);
      const page = await getCachedPage(pageNumber);
      const content = await getCachedTextContent(page);
      chunks.push(...chunkAiText(content.items.map((item) => item.str).join(" "), pageNumber));
      if (index % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return chunks;
  })();
  try {
    documentContextIndex = await documentIndexLoading;
    return documentContextIndex;
  } finally {
    documentIndexLoading = null;
  }
}
function rankAiChunks(chunks, query) {
  const terms = [...new Set(aiTokens(query))];
  return chunks.map((chunk) => {
    const counts = new Map();
    chunk.tokens.forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
    let score = chunk.page === currentPage ? .45 : 0;
    terms.forEach((term) => {
      const count = counts.get(term) || 0;
      if (count) score += 1 + Math.log1p(count);
      else if (chunk.content.toLowerCase().includes(term)) score += .35;
    });
    return { ...chunk, score };
  }).sort((a, b) => b.score - a.score || Math.abs(a.page - currentPage) - Math.abs(b.page - currentPage));
}
async function buildAiContext(question, signal) {
  if (aiScope === "selection" && aiSelection) {
    const page = await pageContext();
    renderAiSources([currentPage]);
    return `SELECCIÓN (p. ${currentPage}):\n${aiSelection}\n\nCONTEXTO DE PÁGINA (p. ${currentPage}):\n${page}`.slice(0, 7500);
  }
  if (aiScope === "page") {
    const page = await pageContext();
    renderAiSources([currentPage]);
    return `PÁGINA ${currentPage}:\n${page}`.slice(0, 7500);
  }
  const chunks = await ensureDocumentContextIndex(signal);
  const ranked = rankAiChunks(chunks, `${question} ${aiSelection}`);
  const selected = ranked.filter((chunk) => chunk.score > 0).slice(0, 6);
  const fallback = selected.length ? selected : ranked.slice(0, 4);
  const pages = fallback.map((chunk) => chunk.page);
  renderAiSources(pages);
  return fallback.map((chunk) => `[PÁGINA ${chunk.page}]\n${chunk.content}`).join("\n\n").slice(0, 9000);
}
async function inspectAiCapability() {
  if (globalThis.LanguageModel?.availability) {
    try {
      const availability =
        await globalThis.LanguageModel.availability(BUILTIN_AI_OPTIONS);
      if (availability !== "unavailable")
        return { kind: "builtin", availability };
    } catch {}
  }
  if (!isSecureContext)
    return {
      kind: "none",
      reason: "La IA local necesita una conexión segura (HTTPS).",
    };
  if (!navigator.gpu)
    return {
      kind: "none",
      reason:
        "Este navegador no ofrece WebGPU. Prueba con Chrome o Edge actualizados.",
    };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
      return {
        kind: "none",
        reason: "WebGPU está desactivado o tu GPU no es compatible.",
      };
    const storage = await navigator.storage?.estimate?.();
    const free = Math.max(0, (storage?.quota || 0) - (storage?.usage || 0));
    if (free && free < 1_100_000_000)
      return {
        kind: "none",
        reason:
          "No hay espacio local suficiente para el modelo (necesita aproximadamente 1 GB).",
      };
    return { kind: "webllm" };
  } catch {
    return {
      kind: "none",
      reason: "No se pudo inicializar WebGPU en este dispositivo.",
    };
  }
}
async function openAiAssistantLegacy(fromCapture = false) {
  const text = window.getSelection()?.toString().trim();
  if (!fromCapture && !text)
    return toast("Selecciona un fragmento para consultarlo");
  if (!fromCapture) aiImage = "";
  aiSelection = (text || "").slice(0, 5000);
  aiScope = "selection";
  $("aiScope").value = aiScope;
  aiAnswerRaw = "";
  renderAiAnswer();
  $("aiSelectionLabel").textContent = fromCapture
    ? "Recorte seleccionado"
    : "Fragmento seleccionado";
  $("aiQuote").textContent = fromCapture
    ? "Captura de una zona del PDF lista para analizar."
    : aiSelection;
  $("aiImagePreview").hidden = !fromCapture;
  $("aiImagePreview").src = fromCapture ? aiImage : "";
  $("aiQuestion").value = fromCapture
    ? "Describe la información visible en esta captura y señala los elementos importantes."
    : "Explícame este fragmento de forma clara y señala las ideas principales.";
  document
    .querySelectorAll("[data-ai-prompt]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.textContent.includes("Explicar"),
      ),
    );
  $("aiPanel").hidden = false;
  hideAnnotationActions();
  if (fromCapture) {
    aiStatus(
      "Captura lista. El modelo local actual es textual: podrás consultarla cuando actives un modelo con visión.",
    );
    $("aiQuestion").focus();
    return;
  }
  aiStatus("Comprobando compatibilidad de IA local…");
  const capability = await inspectAiCapability();
  aiStatus(
    capability.kind === "builtin"
      ? capability.availability === "available"
        ? "Modelo local del navegador listo."
        : "El navegador descargará su modelo local al consultar."
      : capability.kind === "webllm"
        ? "IA local disponible con WebGPU. La primera descarga ocupa aproximadamente 900 MB."
        : capability.reason,
  );
  $("aiQuestion").focus();
}
function closeAiAssistant() {
  aiAbortController?.abort();
  $("aiPanel").hidden = true;
  setAssistantButton(false);
}
async function openAssistantForDocument() {
  if (!currentBook) return toast("Abre un documento primero");
  $("aiCard")._expandAi?.();
  aiScope = "document";
  aiSelection = "";
  aiImage = "";
  aiImagePage = 0;
  $("aiScope").value = "document";
  $("aiSelectionLabel").textContent = "Documento";
  $("aiQuote").textContent = "Paper buscará localmente las páginas más relevantes para cada pregunta.";
  $("aiImagePreview").hidden = true;
  renderAiSources([]);
  renderAiConversation();
  $("aiQuestion").placeholder = "Pregunta sobre este documento…";
  $("aiPanel").hidden = false;
  setAssistantButton(true);
  aiStatus("Comprobando la IA local de este dispositivo…");
  $("aiQuestion").focus();
  const capability = await inspectAiCapability();
  if ($("aiPanel").hidden) return;
  aiStatus(
    capability.kind === "builtin"
      ? capability.availability === "available"
        ? "IA integrada lista. Todo se procesa en este dispositivo."
        : "IA integrada compatible. El navegador descargará su modelo al consultar."
      : capability.kind === "webllm"
        ? "IA local compatible mediante WebGPU · primera descarga aproximada: 900 MB."
        : capability.reason,
  );
}
async function inspectVisionCapability() {
  if (globalThis.LanguageModel?.availability) {
    try {
      const availability = await globalThis.LanguageModel.availability(
        BUILTIN_VISION_OPTIONS,
      );
      if (availability !== "unavailable")
        return { ok: true, kind: "builtin", availability };
    } catch (error) {
      console.info("La IA integrada no admite imagen en este navegador", error);
    }
  }
  if (!isSecureContext)
    return { ok: false, kind: "none", reason: "La visión local necesita HTTPS." };
  if (!navigator.gpu)
    return {
      ok: false,
      kind: "none",
      reason: "Este navegador no ofrece WebGPU para ejecutar visión local.",
    };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
      return {
        ok: false,
        kind: "none",
        reason: "WebGPU está desactivado o tu GPU no es compatible.",
      };
    const storage = await navigator.storage?.estimate?.(),
      free = Math.max(0, (storage?.quota || 0) - (storage?.usage || 0));
    if (free && free < 4_500_000_000)
      return {
        ok: false,
        kind: "none",
        reason:
          "La visión local necesita aproximadamente 4,5 GB libres en este dispositivo.",
      };
    const webllm = await import("https://esm.run/@mlc-ai/web-llm@0.2.84");
    const model = chooseWebLlmModel(webllm, true);
    return { ok: true, kind: "webllm", availability: "downloadable", model };
  } catch (error) {
    console.error("No se pudo preparar WebGPU para visión", error);
    return {
      ok: false,
      kind: "none",
      reason: "No se pudo preparar WebGPU para visión local.",
    };
  }
}
function friendlyAiError(error, vision = false) {
  const message = String(
    error?.message || (typeof error === "string" ? error : ""),
  ).trim();
  const details = `${error?.name || ""} ${message}`.toLowerCase();
  if (/out of memory|memory|allocation|device lost|gpu device/.test(details))
    return vision
      ? "La GPU no tiene memoria suficiente para el modelo visual de 4 GB. Prueba la IA integrada de Chrome/Edge o usa un equipo con más memoria gráfica."
      : "La GPU no tiene memoria suficiente para cargar el modelo local.";
  if (/quota|storage|cache|space|disk/.test(details))
    return "No hay espacio local suficiente para terminar la descarga del modelo. Libera almacenamiento del navegador y vuelve a intentarlo.";
  if (/network|fetch|failed to fetch|cors|load model/.test(details))
    return "La descarga del modelo se interrumpió. Comprueba la conexión y pulsa Consultar para reanudarla; el progreso descargado se conserva.";
  if (/notsupported|not supported|unsupported/.test(details))
    return vision
      ? "El modelo de IA de este navegador no admite imágenes en este dispositivo. Se intentará WebGPU cuando esté disponible."
      : "Este navegador no admite el modelo local solicitado.";
  if (/wasm|linkerror|instantiate|tvmffi/.test(details))
    return "El motor visual guardado es incompatible con esta versión. Recarga la aplicación para actualizar el modelo local.";
  return message
    ? `No se pudo iniciar la IA${vision ? " visual" : ""}: ${message}`
    : `No se pudo iniciar la IA${vision ? " visual" : ""}. Comprueba WebGPU, memoria y espacio disponible.`;
}
async function copyAiAnswer() {
  const answer = aiAnswerRaw.trim() || [...aiMessages].reverse().find((message) => message.role === "assistant")?.content || "";
  if (!answer) return;
  try {
    await navigator.clipboard.writeText(answer);
    toast("Respuesta copiada");
  } catch {
    toast("No se pudo copiar la respuesta");
  }
}
async function getBuiltInAi() {
  if (builtInAiSession) return builtInAiSession;
  const availability =
    await globalThis.LanguageModel.availability(BUILTIN_AI_OPTIONS);
  if (availability === "unavailable") return null;
  aiStatus(
    availability === "available"
      ? "Iniciando modelo integrado…"
      : "Descargando el modelo integrado del navegador…",
  );
  builtInAiSession = await globalThis.LanguageModel.create({
    ...BUILTIN_AI_OPTIONS,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) =>
        aiStatus(
          `Descargando modelo integrado: ${Math.round(e.loaded * 100)}%`,
        ),
      );
    },
  });
  return builtInAiSession;
}
async function getBuiltInVisionAi() {
  if (builtInVisionSession) return builtInVisionSession;
  if (!globalThis.LanguageModel?.availability)
    throw new Error("La IA integrada no está disponible en este navegador.");
  const availability = await globalThis.LanguageModel.availability(
    BUILTIN_VISION_OPTIONS,
  );
  if (availability === "unavailable")
    throw new DOMException(
      "El modelo integrado no admite imágenes en este dispositivo.",
      "NotSupportedError",
    );
  aiStatus(
    availability === "available"
      ? "Preparando visión integrada…"
      : "Descargando visión integrada del navegador…",
  );
  builtInVisionSession = await globalThis.LanguageModel.create({
    ...BUILTIN_VISION_OPTIONS,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) =>
        aiStatus(
          `Descargando visión integrada: ${Math.round(event.loaded * 100)}%`,
        ),
      );
    },
  });
  return builtInVisionSession;
}
function chooseWebLlmModel(webllm, vision = false) {
  const models = webllm.prebuiltAppConfig?.model_list || [];
  const entries = models.map((entry) => ({ ...entry, id: entry.model_id || "" })).filter((entry) => entry.id);
  const visionModels = entries.filter((entry) => /vision|llava|smolvlm|qwen[^/]*vl|vlm/i.test(`${entry.id} ${entry.model_type || ""}`));
  if (vision) {
    const preferred = visionModels
      .filter((entry) => /q4|q3|q0f16/i.test(entry.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0] || visionModels[0];
    if (!preferred)
      throw new DOMException("La versión local del motor no publica un modelo visual compatible. Prueba la IA integrada de Chrome o Edge.", "NotSupportedError");
    return preferred.id;
  }
  const preferred = entries.find((entry) => entry.id === "Llama-3.2-1B-Instruct-q4f16_1-MLC")
    || entries.find((entry) => /(?:1B|2B|3B).*Instruct.*q4f16_1/i.test(entry.id) && !visionModels.includes(entry))
    || entries.find((entry) => /Instruct.*q4/i.test(entry.id) && !visionModels.includes(entry));
  return preferred?.id || "Llama-3.2-1B-Instruct-q4f16_1-MLC";
}
async function getWebLlmAi() {
  if (localAiEngine) return localAiEngine;
  if (localAiLoading) return localAiLoading;
  localAiLoading = (async () => {
    aiStatus("Preparando motor de IA local…");
    const webllm = await import("https://esm.run/@mlc-ai/web-llm@0.2.84");
    const model = chooseWebLlmModel(webllm);
    localAiWorker = new Worker("/ai-worker.js?v=1", { type: "module" });
    localAiEngine = await webllm.CreateWebWorkerMLCEngine(
      localAiWorker,
      model,
      {
        initProgressCallback: (p) =>
          aiStatus(p.text || "Descargando modelo local…"),
      },
    );
    return localAiEngine;
  })();
  try {
    return await localAiLoading;
  } catch (e) {
    localAiWorker?.terminate();
    localAiWorker = null;
    throw e;
  } finally {
    localAiLoading = null;
  }
}
async function getVisionAi() {
  if (visionAiEngine) return visionAiEngine;
  if (visionAiLoading) return visionAiLoading;
  visionAiLoading = (async () => {
    const capability = await inspectVisionCapability();
    if (!capability.ok) throw new Error(capability.reason);
    aiStatus("Descargando modelo visual local (aprox. 4 GB)…");
    const webllm = await import("https://esm.run/@mlc-ai/web-llm@0.2.84");
    const model = chooseWebLlmModel(webllm, true);
    visionAiWorker = new Worker("/ai-worker.js?v=1", { type: "module" });
    visionAiEngine = await webllm.CreateWebWorkerMLCEngine(
      visionAiWorker,
      model,
      {
        initProgressCallback: (p) =>
          aiStatus(p.text || "Preparando visión local…"),
      },
    );
    return visionAiEngine;
  })();
  try {
    return await visionAiLoading;
  } catch (e) {
    visionAiWorker?.terminate();
    visionAiWorker = null;
    throw e;
  } finally {
    visionAiLoading = null;
  }
}
async function openAiAssistant(fromCapture = false) {
  const text = window.getSelection()?.toString().trim();
  if (!fromCapture && !text)
    return toast("Selecciona un fragmento para consultarlo");
  if (!fromCapture) {
    aiImage = "";
    aiImagePage = 0;
  }
  aiSelection = fromCapture ? "" : (text || "").slice(0, 5000);
  aiScope = "selection";
  $("aiScope").value = aiScope;
  $("aiSelectionLabel").textContent = fromCapture
    ? "Recorte seleccionado"
    : "Fragmento seleccionado";
  $("aiQuote").textContent = fromCapture
    ? "Captura de una zona del PDF lista para analizar."
    : aiSelection;
  $("aiImagePreview").hidden = !fromCapture;
  $("aiImagePreview").src = fromCapture ? aiImage : "";
  renderAiSources([fromCapture ? aiImagePage || currentPage : currentPage]);
  renderAiConversation();
  $("aiQuestion").value = fromCapture
    ? "Describe la información visible en esta captura y señala los elementos importantes."
    : "Explícame este fragmento de forma clara y señala las ideas principales.";
  document
    .querySelectorAll("[data-ai-prompt]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.textContent.includes("Explicar"),
      ),
    );
  $("aiPanel").hidden = false;
  hideAnnotationActions();
  if (fromCapture) {
    aiStatus("Comprobando si este dispositivo puede ejecutar visión local…");
    const vision = await inspectVisionCapability();
    aiStatus(
      vision.ok
        ? vision.kind === "builtin"
          ? vision.availability === "available"
            ? "Visión integrada lista. La captura se procesa localmente en el navegador."
            : "El navegador preparará su modelo visual integrado al consultar."
          : "Visión WebGPU disponible. La primera consulta descargará aproximadamente 4 GB y no enviará la captura a ningún servidor."
        : vision.reason,
    );
    $("aiQuestion").focus();
    return;
  }
  aiStatus("Comprobando compatibilidad de IA local…");
  const capability = await inspectAiCapability();
  aiStatus(
    capability.kind === "builtin"
      ? capability.availability === "available"
        ? "Modelo local del navegador listo."
        : "El navegador descargará su modelo local al consultar."
      : capability.kind === "webllm"
        ? "IA local disponible con WebGPU. La primera descarga ocupa aproximadamente 900 MB."
        : capability.reason,
  );
  $("aiQuestion").focus();
}
async function pageContext() {
  if (currentBook?.kind === "markdown") return markdownContent.slice(0, 7500);
  if (!pdfDoc) return "";
  const page = await getCachedPage(currentPage);
  const content = await getCachedTextContent(page);
  return content.items
    .map((item) => item.str)
    .join(" ")
    .slice(0, 6000);
}
async function askLocalAiLegacy() {
  if (aiImage && !aiSelection) {
    aiStatus(
      "Esta captura necesita un modelo local con visión. El modelo instalado actualmente procesa texto, no imágenes.",
    );
    return;
  }
  if (!aiSelection) return;
  const button = $("askAiSubmit"),
    question = $("aiQuestion").value.trim() || "Explica este texto.";
  button.disabled = true;
  $("cancelAi").hidden = false;
  aiAnswerRaw = "";
  renderAiAnswer();
  aiAbortController = new AbortController();
  try {
    const capability = await inspectAiCapability();
    if (capability.kind === "none") throw new Error(capability.reason);
    const context = await pageContext();
    const prompt = `Actúa como un asistente de lectura riguroso y responde siempre en español. Usa solo el texto proporcionado; si falta información, indícalo.\n\nFragmento seleccionado:\n---\n${aiSelection}\n---\n\nContexto de la página:\n---\n${context}\n---\n\nPregunta: ${question}`;
    if (capability.kind === "builtin") {
      const session = await getBuiltInAi();
      aiStatus("Pensando en tu dispositivo…");
      await streamBuiltInAnswer(session, prompt, aiAbortController.signal);
    } else {
      const engine = await getWebLlmAi();
      aiStatus("Pensando en tu dispositivo…");
      const stream = await engine.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente de lectura riguroso. Responde siempre en español y usa únicamente el texto proporcionado.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 450,
        stream: true,
      });
      for await (const chunk of stream) {
        if (aiAbortController.signal.aborted) break;
        appendAiChunk(chunk.choices[0]?.delta?.content || "");
      }
    }
    aiStatus(
      "Respuesta generada localmente. El documento no ha salido de tu navegador.",
    );
    $("copyAiAnswer").hidden = !aiAnswerRaw.trim();
  } catch (e) {
    if (e.name === "AbortError") {
      aiStatus("Consulta detenida.");
      return;
    }
    console.error(e);
    aiStatus(`IA no disponible: ${e.message || "error de inicialización"}`);
  } finally {
    button.disabled = false;
    $("cancelAi").hidden = true;
    aiAbortController = null;
  }
}

function renderSearchResults() {
  const section = $("searchResultsSection"),
    list = $("searchResults");
  updateSearchCounter();
  if (!searchMatches.length) {
    if (!searchRawQuery) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    section.hidden = false;
    list.innerHTML = '<span style="color:var(--muted);font-size:13px;padding:0 9px">Sin coincidencias.</span>';
    return;
  }
  section.hidden = false;
  const entry = (match, index) =>
    `<button class="bookmark ${index === searchIndex ? "active" : ""}" data-search-index="${index}"><strong>Página ${match.page}</strong><small>${escapeHtml(match.snippet)}</small></button>`;
  if (searchScope === "library") {
    const groups = new Map();
    searchMatches.forEach((match, index) => {
      if (!groups.has(match.docId)) groups.set(match.docId, { name: match.docName, items: [] });
      groups.get(match.docId).items.push({ index });
    });
    let html = "";
    for (const [, group] of groups) {
      html += `<div class="search-doc-group"><span>${escapeHtml(group.name)}</span><em>${group.items.length}</em></div>`;
      html += group.items.map(({ index }) => entry(searchMatches[index], index)).join("");
    }
    list.innerHTML = html;
  } else {
    list.innerHTML = searchMatches.map((match, index) => entry(match, index)).join("");
  }
  document.querySelectorAll("[data-search-index]").forEach(
    (button) => (button.onclick = () => openSearchMatch(Number(button.dataset.searchIndex))),
  );
}
// Construye una expresión regular según las opciones (mayúsculas, palabra
// completa, regex libre). Devuelve null si el patrón regex no es válido.
function buildSearchRegex(rawQuery) {
  const query = rawQuery.trim();
  if (!query) return null;
  const flags = searchOptions.caseSensitive ? "g" : "gi";
  try {
    if (searchOptions.regex) return new RegExp(query, flags);
    let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (searchOptions.wholeWord) escaped = `\\b${escaped}\\b`;
    return new RegExp(escaped, flags);
  } catch {
    return null;
  }
}
function collectPageMatches(text, regex, page, extra = {}) {
  const matches = [];
  regex.lastIndex = 0;
  let match,
    guard = 0;
  while ((match = regex.exec(text)) && guard++ < 5000) {
    if (match.index === regex.lastIndex) regex.lastIndex++;
    if (!match[0]) continue;
    const at = match.index;
    matches.push({
      page,
      snippet: text.slice(Math.max(0, at - 42), at + match[0].length + 72).replace(/\s+/g, " ").trim(),
      ...extra,
    });
  }
  return matches;
}
function currentSearchSignature(raw) {
  return `${searchScope}|${raw}|${JSON.stringify(searchOptions)}`;
}
async function search(query) {
  const raw = (query ?? $("searchInput").value ?? "").trim();
  if (!raw) return;
  if (searchScope === "library") return searchLibrary(raw);
  if (!pdfDoc) return;
  const regex = buildSearchRegex(raw);
  if (!regex) {
    toast("Expresión regular no válida");
    return;
  }
  const signature = currentSearchSignature(raw);
  // Repetir la misma búsqueda avanza a la siguiente coincidencia.
  if (signature === searchSignature && searchMatches.length) {
    navigateSearch(1);
    return;
  }
  const token = ++searchToken;
  searchSignature = signature;
  searchRawQuery = raw;
  searchQuery = raw.toLowerCase();
  searchRegex = regex;
  searchMatches = [];
  searchIndex = -1;
  showLoader(true, "Buscando…", `“${raw}”`);
  try {
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== searchToken) return;
      const p = await getCachedPage(i);
      const tc = await getCachedTextContent(p);
      const text = tc.items.map((x) => x.str).join(" ");
      searchMatches.push(...collectPageMatches(text, regex, i));
      $("loaderText").textContent = `Página ${i} de ${pdfDoc.numPages}`;
    }
    if (!searchMatches.length) {
      renderSearchResults();
      toast("Sin coincidencias");
      return;
    }
    const afterCurrent = searchMatches.findIndex((match) => match.page >= currentPage);
    searchIndex = afterCurrent < 0 ? 0 : afterCurrent;
    await jumpToPage(searchMatches[searchIndex].page);
    renderSearchResults();
    toast(`${searchMatches.length} coincidencia${searchMatches.length > 1 ? "s" : ""}`);
  } finally {
    showLoader(false);
  }
}
// Busca el término en el texto de todos los PDFs guardados en la biblioteca.
async function searchLibrary(raw) {
  const regex = buildSearchRegex(raw);
  if (!regex) {
    toast("Expresión regular no válida");
    return;
  }
  const token = ++searchToken;
  const libToken = ++librarySearchToken;
  searchSignature = currentSearchSignature(raw);
  searchRawQuery = raw;
  searchQuery = raw.toLowerCase();
  searchRegex = regex;
  searchMatches = [];
  searchIndex = -1;
  const records = (await dbAll()).filter((record) => record.kind !== "markdown" && record.blob);
  showLoader(true, "Buscando en la biblioteca…", `“${raw}”`);
  try {
    for (let d = 0; d < records.length; d++) {
      if (token !== searchToken || libToken !== librarySearchToken) return;
      const record = records[d];
      $("loaderText").textContent = `${record.name} · ${d + 1}/${records.length}`;
      try {
        const doc =
          currentBook?.id === record.id && pdfDoc
            ? pdfDoc
            : await pdfjsLib.getDocument({ data: new Uint8Array(await record.blob.arrayBuffer()) }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          if (token !== searchToken || libToken !== librarySearchToken) return;
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const text = content.items.map((x) => x.str).join(" ");
          searchMatches.push(...collectPageMatches(text, regex, i, { docId: record.id, docName: record.name }));
        }
        if (doc !== pdfDoc) doc.destroy?.();
      } catch (error) {
        console.warn("No se pudo buscar en", record.name, error);
      }
    }
    if (!searchMatches.length) {
      renderSearchResults();
      toast("Sin coincidencias en la biblioteca");
      return;
    }
    searchIndex = 0;
    renderSearchResults();
    toast(
      `${searchMatches.length} coincidencia${searchMatches.length > 1 ? "s" : ""} en ${new Set(searchMatches.map((m) => m.docId)).size} documento(s)`,
    );
  } finally {
    showLoader(false);
  }
}
function updateSearchCounter() {
  const counter = $("searchCounter");
  if (!counter) return;
  counter.textContent = searchMatches.length ? `${searchIndex + 1} / ${searchMatches.length}` : "—";
}
async function openSearchMatch(index) {
  if (index < 0 || index >= searchMatches.length) return;
  searchIndex = index;
  const match = searchMatches[index];
  if (match.docId && match.docId !== currentBook?.id) {
    preserveSearchOnOpen = true;
    await openStored(match.docId);
    searchRegex = buildSearchRegex(searchRawQuery);
    searchQuery = searchRawQuery.toLowerCase();
  }
  await jumpToPage(match.page);
  renderSearchResults();
}
function navigateSearch(direction) {
  if (!searchMatches.length) return;
  openSearchMatch((searchIndex + direction + searchMatches.length) % searchMatches.length);
}

async function streamWebLlmVision(question) {
  const engine = await getVisionAi();
  aiStatus("Analizando la captura con WebGPU…");
  const stream = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "Eres un asistente de lectura visual riguroso. Responde siempre en español.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: aiImage } },
        ],
      },
    ],
    temperature: 0.25,
    max_tokens: 500,
    stream: true,
  });
  for await (const chunk of stream) {
    if (aiAbortController.signal.aborted) break;
    appendAiChunk(chunk.choices[0]?.delta?.content || "");
  }
}

function showEmpty() {
  if (ttsActive) stopReadAloud();
  document.body.classList.remove("has-doc");
  setStickyPlacement(false);
  if (!$("notebookPanel").hidden) closeNotebook();
  setAutoScroll(false);
  closeStudy();
  if (rulerOn) {
    rulerOn = false;
    $("readingRuler").hidden = true;
  }
  updateRemainingTime();
  $("emptyState").hidden = false;
  $("canvasWrap").hidden = true;
  $("reflowReader").hidden = true;
  $("docTitle").textContent = "Paper Reader";
  $("docMeta").textContent = "Tus documentos se quedan en este dispositivo";
  $("pageStatus").textContent = "Sin documento";
  $("pageStatus").hidden = false;
  $("pageTotal").textContent = "";
  $("pageJump").hidden = true;
  $("toolbarPage").value = 1;
  $("toolbarPage").max = 1;
  $("toolbarPage").disabled = true;
  $("toolbarPageCount").textContent = "/ —";
  $("toolbarPrev").disabled = true;
  $("toolbarNext").disabled = true;
  $("pageScrubber").value = 1;
  $("pageScrubber").max = 1;
  $("pageScrubber").disabled = true;
  $("progressBar").style.width = "0";
  $("outlineList").innerHTML = "";
  $("annotationList").innerHTML = "";
  searchQuery = "";
  searchRawQuery = "";
  searchRegex = null;
  searchSignature = "";
  searchMatches = [];
  searchIndex = -1;
  renderSearchResults();
  resetThumbnails();
  renderBookmarks();
}

async function askLocalAi() {
  const isVision = Boolean(aiImage && aiScope === "selection"),
    button = $("askAiSubmit"),
    question = $("aiQuestion").value.trim() || (isVision ? "Describe esta captura." : "Explica este contenido.");
  if (!isVision && aiScope === "selection" && !aiSelection)
    return toast("Selecciona texto, añade un recorte o cambia el ámbito de la consulta");
  const messagesBeforeRequest = structuredClone(aiMessages);
  button.disabled = true;
  $("cancelAi").hidden = false;
  aiAnswerRaw = "";
  aiMessages.push({ role: "user", content: question, createdAt: Date.now() });
  renderAiConversation();
  renderAiAnswer();
  aiAbortController = new AbortController();
  try {
    if (isVision) {
      const vision = await inspectVisionCapability();
      if (!vision.ok) throw new Error(vision.reason);
      renderAiSources([aiImagePage || currentPage]);
      const history = messagesBeforeRequest.slice(-6).map((message) => `${message.role === "user" ? "Usuario" : "Asistente"}: ${message.content}`).join("\n");
      const visionQuestion = `${history ? `Conversación previa:\n${history}\n\n` : ""}${question}`;
      if (vision.kind === "builtin") {
        try {
          const session = await getBuiltInVisionAi();
          const imageBlob = await fetch(aiImage).then((response) =>
            response.blob(),
          );
          aiStatus("Analizando la captura con la IA integrada…");
          const prompt = [
            {
              role: "user",
              content: [
                { type: "text", value: visionQuestion },
                { type: "image", value: imageBlob },
              ],
            },
          ];
          await streamBuiltInAnswer(session, prompt, aiAbortController.signal);
        } catch (builtInError) {
          builtInVisionSession = null;
          console.warn(
            "La visión integrada falló; se intenta WebGPU",
            builtInError,
          );
          aiStatus("La visión integrada no respondió. Probando WebGPU…");
          await streamWebLlmVision(visionQuestion);
        }
      } else {
        await streamWebLlmVision(visionQuestion);
      }
    } else {
      const capability = await inspectAiCapability();
      if (capability.kind === "none") throw new Error(capability.reason);
      const context = await buildAiContext(question, aiAbortController.signal);
      const history = messagesBeforeRequest.slice(-6).map((message) => `${message.role === "user" ? "Usuario" : "Asistente"}: ${message.content}`).join("\n\n");
      const prompt = `Actúa como un asistente documental riguroso. Responde siempre en español y usa exclusivamente el contexto incluido. Si la respuesta no está en él, dilo claramente. Cuando el contexto indique páginas, cita las afirmaciones como [p. N].\n\nCONTEXTO LOCAL:\n---\n${context}\n---\n${history ? `\nCONVERSACIÓN PREVIA:\n${history}\n` : ""}\nPREGUNTA: ${question}`;
      if (capability.kind === "builtin") {
        const session = await getBuiltInAi();
        aiStatus("Pensando en tu dispositivo…");
        await streamBuiltInAnswer(session, prompt, aiAbortController.signal);
      } else {
        const engine = await getWebLlmAi();
        aiStatus("Pensando en tu dispositivo…");
        const stream = await engine.chat.completions.create({
          messages: [
            {
              role: "system",
              content:
                "Eres un asistente documental riguroso. Responde en español, no inventes información y cita las páginas del contexto como [p. N].",
            },
            ...messagesBeforeRequest.slice(-6).map((message) => ({ role: message.role, content: message.content })),
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 700,
          stream: true,
        });
        for await (const chunk of stream) {
          if (aiAbortController.signal.aborted) break;
          appendAiChunk(chunk.choices[0]?.delta?.content || "");
        }
      }
    }
    const answer = aiAnswerRaw.trim();
    if (!answer) throw new Error("El modelo no devolvió una respuesta.");
    aiMessages.push({ role: "assistant", content: answer, sources: [...aiSourcePages], createdAt: Date.now() });
    saveAiConversation();
    renderAiConversation();
    aiAnswerRaw = "";
    renderAiAnswer();
    aiStatus(
      "Respuesta generada localmente. El documento no ha salido de tu navegador.",
    );
    $("copyAiAnswer").hidden = false;
  } catch (e) {
    if (e.name === "AbortError") {
      aiMessages = messagesBeforeRequest;
      aiAnswerRaw = "";
      renderAiConversation();
      renderAiAnswer();
      aiStatus("Consulta detenida.");
      return;
    }
    console.error(e);
    aiMessages = messagesBeforeRequest;
    aiAnswerRaw = "";
    renderAiConversation();
    renderAiAnswer();
    aiStatus(friendlyAiError(e, isVision));
  } finally {
    button.disabled = false;
    $("cancelAi").hidden = true;
    aiAbortController = null;
  }
}
// Por debajo de 1180px la barra lateral es un cajón flotante (ver CSS).
function isDrawerLayout() {
  return window.innerWidth < 1180;
}
function toggleSidebar() {
  if (isDrawerLayout()) {
    document.body.classList.toggle("sidebar-open");
    return;
  }
  document.body.classList.toggle("sidebar-collapsed");
  scheduleLayoutRefit();
}
function scheduleLayoutRefit() {
  clearTimeout(layoutRefitTimer);
  if (pdfDoc) requestAnimationFrame(refitZoom);
  layoutRefitTimer = setTimeout(refitZoom, 240);
}
function setSidebarPanel(panel) {
  const notes = panel === "notes";
  $("sidebarContentsPanel").hidden = notes;
  $("sidebarNotesPanel").hidden = !notes;
  $("sidebarContentsTab").classList.toggle("active", !notes);
  $("sidebarNotesTab").classList.toggle("active", notes);
  $("sidebarContentsTab").setAttribute("aria-selected", String(!notes));
  $("sidebarNotesTab").setAttribute("aria-selected", String(notes));
}
$("fileInput").onchange = (e) => addFile(e.target.files?.[0]);
$("prevBtn").onclick = () => stepPage(-1);
$("nextBtn").onclick = () => stepPage(1);
$("toolbarPrev").onclick = () => stepPage(-1);
$("toolbarNext").onclick = () => stepPage(1);
$("navBack").onclick = navigateBack;
$("navForward").onclick = navigateForward;
document.querySelectorAll("[data-view-mode]").forEach((button) => {
  button.onclick = () => setViewMode(button.dataset.viewMode);
});
$("presentationBtn").onclick = () => {
  $("appearancePopover").classList.remove("open");
  enterPresentation();
};
$("pmPrev").onclick = () => stepPage(-1);
$("pmNext").onclick = () => stepPage(1);
$("pmExit").onclick = exitPresentation;
$("toolbarPage").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) jumpToPage(page);
  else e.target.value = currentPage;
};
$("zoomIn").onclick = () => changeReaderZoom(ZOOM_STEP);
$("zoomOut").onclick = () => changeReaderZoom(-ZOOM_STEP);
$("zoomLabel").onclick = (event) => toggleZoomMenu(event);
$("fitBtn").onclick = fitWidth;
$("toolbarFitBtn").onclick = fitWidth;
$("bookmarkBtn").onclick = toggleBookmark;
$("searchBtn").onclick = () => search($("searchInput").value);
$("searchInput").onkeydown = (e) => {
  if (e.key === "Enter") {
    if (e.shiftKey && searchMatches.length) navigateSearch(-1);
    else search(e.target.value);
  }
};
// Opciones de búsqueda (mayúsculas, palabra completa, regex).
function applySearchOptionButtons() {
  $("searchCaseBtn")?.setAttribute("aria-pressed", String(searchOptions.caseSensitive));
  $("searchCaseBtn")?.classList.toggle("active", searchOptions.caseSensitive);
  $("searchWordBtn")?.setAttribute("aria-pressed", String(searchOptions.wholeWord));
  $("searchWordBtn")?.classList.toggle("active", searchOptions.wholeWord);
  $("searchRegexBtn")?.setAttribute("aria-pressed", String(searchOptions.regex));
  $("searchRegexBtn")?.classList.toggle("active", searchOptions.regex);
}
function toggleSearchOption(name) {
  searchOptions[name] = !searchOptions[name];
  if (name === "regex" && searchOptions.regex) searchOptions.wholeWord = false;
  setJSON("paper.search-options", searchOptions);
  applySearchOptionButtons();
  // Forzar una nueva búsqueda con las opciones actualizadas.
  searchSignature = "";
  if ($("searchInput").value.trim()) search($("searchInput").value);
}
$("searchCaseBtn").onclick = () => toggleSearchOption("caseSensitive");
$("searchWordBtn").onclick = () => toggleSearchOption("wholeWord");
$("searchRegexBtn").onclick = () => toggleSearchOption("regex");
$("searchPrev").onclick = () => navigateSearch(-1);
$("searchNext").onclick = () => navigateSearch(1);
document.querySelectorAll("[data-search-scope]").forEach((button) => {
  button.onclick = () => {
    searchScope = button.dataset.searchScope;
    document.querySelectorAll("[data-search-scope]").forEach((other) =>
      other.classList.toggle("active", other === button),
    );
    searchSignature = "";
    if ($("searchInput").value.trim()) search($("searchInput").value);
  };
});
searchOptions = { ...searchOptions, ...getJSON("paper.search-options", {}) };
applySearchOptionButtons();
// Lectura en voz alta
$("readAloudBtn").onclick = toggleReadAloud;
$("ttsPlayPause").onclick = toggleTtsPlayPause;
$("ttsPrev").onclick = () => ttsSkip(-1);
$("ttsNext").onclick = () => ttsSkip(1);
$("ttsClose").onclick = stopReadAloud;
$("ttsRate").onchange = (event) => {
  ttsRate = Number(event.target.value) || 1;
  if (ttsActive && !ttsPaused) speakSentence();
};
$("ttsVoice").onchange = (event) => {
  ttsVoiceURI = event.target.value;
  if (ttsActive && !ttsPaused) speakSentence();
};
if (speechSupported) {
  populateTtsVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", populateTtsVoices);
} else {
  $("readAloudBtn").disabled = true;
  $("readAloudBtn").title = "Lectura en voz alta no disponible en este navegador";
}
// Paleta de comandos y atajos
$("paletteBtn").onclick = () => openPalette();
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  document.querySelectorAll(".palette-kbd").forEach((node) => (node.textContent = "⌘ K"));
}
$("paletteInput").addEventListener("input", () => renderPalette());
$("paletteInput").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
    event.preventDefault();
    movePaletteSelection(1);
  } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
    event.preventDefault();
    movePaletteSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteItem(paletteIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
  }
});
$("paletteList").addEventListener("pointermove", (event) => {
  const item = event.target.closest("[data-palette-index]");
  if (!item) return;
  const next = Number(item.dataset.paletteIndex);
  if (next !== paletteIndex) movePaletteSelection(next - paletteIndex);
});
$("paletteList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-palette-index]");
  if (item) runPaletteItem(Number(item.dataset.paletteIndex));
});
$("palette").addEventListener("pointerdown", (event) => {
  if (event.target === $("palette")) closePalette();
});
document.querySelectorAll("[data-palette-opt]").forEach((button) => {
  button.onclick = () => {
    const option = button.dataset.paletteOpt;
    searchOptions[option] = !searchOptions[option];
    if (option === "regex" && searchOptions.regex) searchOptions.wholeWord = false;
    setJSON("paper.search-options", searchOptions);
    applySearchOptionButtons();
    searchSignature = "";
    renderPalette(true);
    $("paletteInput").focus();
  };
});
$("closeShortcuts").onclick = closeShortcuts;
bindStickyInteractions();
bindNotebook();
bindReadingTools();
bindStudy();
bindOutline();
$("shortcutsPanel").addEventListener("pointerdown", (event) => {
  if (event.target === $("shortcutsPanel")) closeShortcuts();
});
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("paper.theme", theme);
  $("themeSelect").value = theme;
  $("appearanceTheme").value = theme;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.classList.toggle("active", button.dataset.themeChoice === theme));
}
$("themeSelect").onchange = (e) => setTheme(e.target.value);
$("appearanceTheme").onchange = (e) => setTheme(e.target.value);
$("openSidebar").onclick = toggleSidebar;
$("sidebarContentsTab").onclick = () => setSidebarPanel("contents");
$("sidebarNotesTab").onclick = () => setSidebarPanel("notes");
$("closeSidebar").onclick = () => {
  if (isDrawerLayout()) document.body.classList.remove("sidebar-open");
  else {
    document.body.classList.add("sidebar-collapsed");
    scheduleLayoutRefit();
  }
};
$("homeBtn").onclick = () => {
  flushReadingSession(true);
  $("libraryPanel").hidden = false;
  renderLibrary();
};
$("emptyLibraryBtn").onclick = $("homeBtn").onclick;
$("closeLibrary").onclick = () => {
  $("libraryPanel").hidden = true;
  markReadingActivity();
};
$("libraryPanel").onclick = (e) => {
  if (e.target === $("libraryPanel")) {
    $("libraryPanel").hidden = true;
    markReadingActivity();
  }
};
$("library").addEventListener("click", (e) => {
  if (e.target.closest(".book")) $("libraryPanel").hidden = true;
});
$("librarySearch").addEventListener("input", renderLibrary);
$("libraryType").addEventListener("change", renderLibrary);
$("librarySort").addEventListener("change", renderLibrary);
$("rotateBtn").onclick = async () => {
  if (!pdfDoc || isRotating) return;
  isRotating = true;
  const button = $("rotateBtn"),
    wasOpen = !$("thumbnailRail").hidden;
  button.disabled = true;
  try {
    rotation = (rotation + 90) % 360;
    resetThumbnails();
    if (viewMode === "continuous") refreshCurrentView();
    else await renderPage(currentPage);
    if (wasOpen) toggleThumbnails();
    toast(`Página girada ${rotation}°`);
  } finally {
    button.disabled = false;
    isRotating = false;
  }
};
$("thumbBtn").onclick = toggleThumbnails;
$("closeThumbs").onclick = toggleThumbnails;
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function updateFocusButton(active = Boolean(fullscreenElement())) {
  const button = $("focusBtn");
  setIcon(button, active ? "minimize" : "maximize");
  button.title = active ? "Salir de pantalla completa" : "Pantalla completa";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(active));
}
function setReaderChromeHidden(hidden, refit = true) {
  document.body.classList.toggle("reader-chrome-hidden", hidden);
  if (hidden) {
    document.body.classList.remove("sidebar-open");
    $("toolPopover").classList.remove("open");
    $("appearancePopover").classList.remove("open");
    $("inkColorCard")?.setAttribute("hidden", "");
    hideAnnotationActions();
  }
  if (refit && pdfDoc) requestAnimationFrame(refitZoom);
}
async function toggleFocusMode() {
  const nativeFullscreen = Boolean(fullscreenElement());
  const active = nativeFullscreen || document.body.classList.contains("focus-mode");
  if (active) {
    const exit = nativeFullscreen && (document.exitFullscreen || document.webkitExitFullscreen);
    if (exit) await exit.call(document);
    else {
      document.body.classList.remove("focus-mode");
      setReaderChromeHidden(false);
      updateFocusButton(false);
    }
    return;
  }
  document.body.classList.add("focus-mode");
  setReaderChromeHidden(true, false);
  updateFocusButton(true);
  const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  try {
    if (request) await request.call(document.documentElement, { navigationUI: "hide" });
    else toast("Modo inmersivo activado");
  } catch {
    toast("Modo inmersivo activado");
  }
  if (pdfDoc) requestAnimationFrame(refitZoom);
}
function syncFullscreenState() {
  const active = Boolean(fullscreenElement());
  // Si el usuario abandona la pantalla completa desde el navegador, salimos
  // también del modo presentación para no dejar la interfaz oculta.
  if (!active && presentationMode) {
    exitPresentation();
    return;
  }
  document.body.classList.toggle("focus-mode", active);
  if (!active) setReaderChromeHidden(false, false);
  updateFocusButton(active);
  if (pdfDoc) requestAnimationFrame(refitZoom);
}
$("focusBtn").onclick = toggleFocusMode;
document.addEventListener("fullscreenchange", syncFullscreenState);
document.addEventListener("webkitfullscreenchange", syncFullscreenState);

let paperTap = null;
$("canvasWrap").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || document.body.classList.contains("ink-drawing-mode")) return;
  paperTap = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
$("canvasWrap").addEventListener("pointercancel", () => { paperTap = null; });
$("canvasWrap").addEventListener("pointerup", (event) => {
  if (!paperTap || paperTap.id !== event.pointerId) return;
  const moved = Math.hypot(event.clientX - paperTap.x, event.clientY - paperTap.y);
  paperTap = null;
  if (
    moved > 8 || markerMode || eraserMode ||
    document.body.classList.contains("ink-drawing-mode") ||
    event.target.closest(".textLayer span, a, button, input, textarea, select")
  ) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
  if (presentationMode) {
    // En presentación, el clic avanza (mitad derecha) o retrocede (izquierda).
    const rect = $("canvasWrap").getBoundingClientRect();
    stepPage(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
    return;
  }
  setReaderChromeHidden(!document.body.classList.contains("reader-chrome-hidden"));
});
$("pageJump").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) jumpToPage(page);
  else if (pdfDoc) e.target.value = currentPage;
};
$("pageScrubber").oninput = (e) => scheduleScrubPage(Number(e.target.value));
$("viewer").addEventListener("scroll", onContinuousScroll, { passive: true });
$("viewer").addEventListener("wheel", (event) => {
  // Ctrl/⌘ + rueda (o pellizco de trackpad) hace zoom sobre el punto que se
  // está mirando. El documento se vuelve a renderizar, no se escala por CSS.
  if (!(event.ctrlKey || event.metaKey) || !pdfDoc || reflowMode) return;
  event.preventDefault();
  wheelZoomDelta += Math.max(-0.28, Math.min(0.28, -event.deltaY * 0.002));
  wheelZoomAnchor = zoomAnchor(event.clientX, event.clientY);
  if (wheelZoomFrame) return;
  wheelZoomFrame = requestAnimationFrame(() => {
    const delta = wheelZoomDelta;
    const anchor = wheelZoomAnchor;
    wheelZoomFrame = 0;
    wheelZoomDelta = 0;
    wheelZoomAnchor = null;
    zoom(delta, anchor);
  });
}, { passive: false });
$("exportNotes").onclick = exportAnnotations;
$("exportMarkdown").onclick = exportMarkdown;
$("annotationImportInput").onchange = async (event) => {
  const [file] = event.target.files || [];
  if (file) await importAnnotationBackup(file);
  event.target.value = "";
};
$("importPdfAnnotations").onclick = importEmbeddedPdfAnnotations;
$("toolsBtn").onclick = () => {
  const pop = $("toolPopover"),
    isOpen = pop.classList.toggle("open");
  $("toolsBtn").setAttribute("aria-expanded", String(isOpen));
};
$("appearanceBtn").onclick = () => {
  const pop = $("appearancePopover"),
    isOpen = pop.classList.toggle("open");
  $("appearanceBtn").setAttribute("aria-expanded", String(isOpen));
};
$("appearanceZoomIn").onclick = () => changeReaderZoom(ZOOM_STEP);
$("appearanceZoomOut").onclick = () => changeReaderZoom(-ZOOM_STEP);
$("appearanceFit").onclick = fitWidth;
document.querySelectorAll("[data-reader-margin]").forEach(
  (button) =>
    (button.onclick = () => {
      const margin = button.dataset.readerMargin;
      $("viewer").classList.remove("margin-compact", "margin-wide");
      if (margin !== "normal") $("viewer").classList.add(`margin-${margin}`);
      localStorage.setItem("paper.reader-margin", margin);
      document
        .querySelectorAll("[data-reader-margin]")
        .forEach((item) => item.classList.toggle("active", item === button));
    }),
);
function applyReflowPreferences() {
  const reader = $("reflowReader");
  const size = Number(localStorage.getItem("paper.reflow-size") || 20);
  const spacing = localStorage.getItem("paper.reflow-spacing") || "normal";
  const font = localStorage.getItem("paper.reflow-font") || "sans";
  const columns = localStorage.getItem("paper.reflow-columns") || "auto";
  const width = localStorage.getItem("paper.reflow-width") || "normal";
  const tracking = localStorage.getItem("paper.reflow-tracking") || "normal";
  const alignment = localStorage.getItem("paper.reflow-alignment") || "left";
  const theme = localStorage.getItem("paper.reflow-theme") || "paper";
  reader.style.setProperty("--reflow-size", `${size}px`);
  reader.style.setProperty("--reflow-leading", spacing === "compact" ? "1.35" : spacing === "relaxed" ? "1.95" : "1.65");
  reader.style.setProperty("--reflow-width", ({ narrow: "680px", normal: "840px", wide: "1040px", fluid: "1280px" })[width] || "840px");
  reader.style.setProperty("--reflow-tracking", tracking === "open" ? ".025em" : "normal");
  reader.classList.remove("font-serif", "font-humanist", "font-mono", "columns-1", "columns-2", "columns-auto", "align-justify");
  if (font !== "sans") reader.classList.add(`font-${font}`);
  reader.classList.add(`columns-${columns}`);
  reader.classList.toggle("align-justify", alignment === "justify");
  reader.dataset.readerTheme = theme;
  $("reflowFont").value = font;
  $("reflowSize").value = String(size);
  $("reflowSizeOutput").textContent = `${size}px`;
  if (reflowMode && $("zoomLabel")) {
    $("zoomLabel").textContent = `${size}px`;
    $("zoomLabel").title = `Tamaño de lectura ${size}px`;
  }
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => button.classList.toggle("active", button.dataset.reflowSpacing === spacing));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => button.classList.toggle("active", button.dataset.reflowColumns === columns));
  document.querySelectorAll("[data-reflow-width]").forEach((button) => button.classList.toggle("active", button.dataset.reflowWidth === width));
  document.querySelectorAll("[data-reflow-tracking]").forEach((button) => button.classList.toggle("active", button.dataset.reflowTracking === tracking));
  document.querySelectorAll("[data-reflow-alignment]").forEach((button) => button.classList.toggle("active", button.dataset.reflowAlignment === alignment));
  document.querySelectorAll("[data-reflow-theme]").forEach((button) => button.classList.toggle("active", button.dataset.reflowTheme === theme));
}
async function setReadingMode(mode) {
  reflowMode = mode === "reflow";
  if (reflowMode && viewMode !== "single") {
    // La lectura maquetada usa el motor de página única.
    if (viewMode === "continuous") teardownContinuous();
    viewMode = "single";
    localStorage.setItem("paper.view-mode", "single");
    document.querySelectorAll("[data-view-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.viewMode === "single"),
    );
    $("viewer").classList.remove("double-mode");
    $("continuousView").hidden = true;
    $("facingWrap").hidden = true;
  }
  localStorage.setItem("paper.reading-mode", mode);
  document.body.classList.toggle("reflow-mode", reflowMode);
  $("markerModeBtn").disabled = reflowMode;
  $("eraserModeBtn").disabled = reflowMode;
  $("reflowControls").hidden = !reflowMode;
  document.querySelectorAll("[data-reading-mode]").forEach((button) => button.classList.toggle("active", button.dataset.readingMode === mode));
  if (reflowMode) applyReflowPreferences();
  else updateZoomLabel();
  if (pdfDoc) await renderPage(currentPage);
  if (reflowMode) {
    $("inkStrip")?.setAttribute("hidden", "");
    $("inkColorCard")?.setAttribute("hidden", "");
    document.body.classList.remove("ink-toolbar-open");
    toast("Modo Lectura activado");
  }
}
function buildReflowControls() {
  const popover = $("appearancePopover");
  if (!popover || $("reflowControls")) return;
  popover.insertAdjacentHTML("beforeend", `<div class="label">Modo</div><div class="tool-row reading-mode-switch" role="group" aria-label="Modo de visualización"><button class="btn" data-reading-mode="pdf">PDF original</button><button class="btn" data-reading-mode="reflow">Lectura</button></div><div class="reflow-controls" id="reflowControls" hidden><div class="reflow-control-head"><strong>Maquetación de lectura</strong><small>El texto se adapta sin modificar el PDF.</small></div><div class="label">Tipografía</div><select class="field" id="reflowFont" aria-label="Fuente de lectura"><option value="sans">Sistema</option><option value="serif">Serif editorial</option><option value="humanist">Humanista accesible</option><option value="mono">Monoespaciada</option></select><label class="reflow-slider"><span>Tamaño <output id="reflowSizeOutput">20px</output></span><input id="reflowSize" type="range" min="14" max="36" step="1" value="20"></label><div class="label">Interlineado</div><div class="tool-row"><button class="btn" data-reflow-spacing="compact">Compacto</button><button class="btn" data-reflow-spacing="normal">Normal</button><button class="btn" data-reflow-spacing="relaxed">Amplio</button></div><div class="label">Ancho de lectura</div><div class="tool-row reflow-four"><button class="btn" data-reflow-width="narrow">Estrecho</button><button class="btn" data-reflow-width="normal">Normal</button><button class="btn" data-reflow-width="wide">Amplio</button><button class="btn" data-reflow-width="fluid">Fluido</button></div><div class="label">Columnas</div><div class="tool-row"><button class="btn" data-reflow-columns="auto">Auto</button><button class="btn" data-reflow-columns="1">Una</button><button class="btn" data-reflow-columns="2">Dos</button></div><div class="label">Texto</div><div class="tool-row"><button class="btn" data-reflow-alignment="left">Izquierda</button><button class="btn" data-reflow-alignment="justify">Justificado</button><button class="btn" data-reflow-tracking="normal">Natural</button><button class="btn" data-reflow-tracking="open">Abierto</button></div><div class="label">Papel de lectura</div><div class="reflow-themes"><button data-reflow-theme="paper" aria-label="Blanco"></button><button data-reflow-theme="warm" aria-label="Cálido"></button><button data-reflow-theme="sepia" aria-label="Sepia"></button><button data-reflow-theme="gray" aria-label="Gris"></button><button data-reflow-theme="night" aria-label="Noche"></button></div><button class="btn reflow-reset" id="reflowReset">Restablecer lectura</button></div>`);
  document.querySelectorAll("[data-reading-mode]").forEach((button) => (button.onclick = () => setReadingMode(button.dataset.readingMode)));
  $("reflowFont").onchange = (event) => { localStorage.setItem("paper.reflow-font", event.target.value); applyReflowPreferences(); };
  $("reflowSize").oninput = (event) => { localStorage.setItem("paper.reflow-size", event.target.value); applyReflowPreferences(); };
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-spacing", button.dataset.reflowSpacing); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-columns", button.dataset.reflowColumns); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-width]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-width", button.dataset.reflowWidth); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-tracking]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-tracking", button.dataset.reflowTracking); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-alignment]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-alignment", button.dataset.reflowAlignment); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-theme]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-theme", button.dataset.reflowTheme); applyReflowPreferences(); }));
  $("reflowReset").onclick = () => {
    ["size", "spacing", "font", "columns", "width", "tracking", "alignment", "theme"].forEach((name) => localStorage.removeItem(`paper.reflow-${name}`));
    applyReflowPreferences();
    toast("Preferencias de lectura restablecidas");
  };
}
function pageColorStorageKey() {
  return currentBook ? key(currentBook.id, `page-color-${currentPage}`) : "paper.page-color";
}
function updatePageColor() {
  pageColor = localStorage.getItem(pageColorStorageKey()) || "paper";
  const wrap = $("canvasWrap");
  wrap.classList.remove("page-color-warm", "page-color-sepia", "page-color-gray", "page-color-night");
  if (pageColor !== "paper") wrap.classList.add(`page-color-${pageColor}`);
  document.querySelectorAll("[data-page-color]").forEach((button) => button.classList.toggle("active", button.dataset.pageColor === pageColor));
}
function setPageColor(color) {
  pageColor = color;
  localStorage.setItem(pageColorStorageKey(), color);
  updatePageColor();
}
function buildPageColorControls() {
  const popover = $("appearancePopover");
  if (!popover || $("pageColors")) return;
  const section = document.createElement("div");
  section.id = "pageColors";
  section.innerHTML = '<div class="label">Color de página</div><div class="page-colors"><button data-page-color="paper" title="Blanco" aria-label="Blanco"></button><button data-page-color="warm" title="Cálido" aria-label="Cálido"></button><button data-page-color="sepia" title="Sepia" aria-label="Sepia"></button><button data-page-color="gray" title="Gris" aria-label="Gris"></button><button data-page-color="night" title="Noche" aria-label="Noche"></button></div><p class="reader-hint">Solo cambia la visualización de esta página.</p>';
  popover.append(section);
  section.querySelectorAll("[data-page-color]").forEach((button) => (button.onclick = () => setPageColor(button.dataset.pageColor)));
}
function buildThemeChoices() {
  const select = $("appearanceTheme");
  if (!select || $("themeChoices")) return;
  const choices = document.createElement("div");
  choices.id = "themeChoices";
  choices.className = "theme-choices";
  choices.setAttribute("aria-label", "Tema de la interfaz");
  choices.innerHTML = '<button data-theme-choice="light"><i></i><span>Claro</span></button><button data-theme-choice="sepia"><i></i><span>Sepia</span></button><button data-theme-choice="dark"><i></i><span>Oscuro</span></button>';
  select.insertAdjacentElement("afterend", choices);
  select.hidden = true;
  choices.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.onclick = () => setTheme(button.dataset.themeChoice);
    button.classList.toggle("active", button.dataset.themeChoice === document.documentElement.dataset.theme);
  });
}
function configureAiWindow() {
  const panel = $("aiPanel");
  const card = panel.querySelector(".ai-card");
  const header = card.querySelector("header");
  if (localStorage.getItem("paper.assistant-layout") !== "2") {
    localStorage.removeItem("paper.ai-window");
    localStorage.setItem("paper.assistant-layout", "2");
  }
  card.id = "aiCard";
  header.id = "aiDragHandle";
  $("aiTitle").textContent = "Paper AI";
  const spark = card.querySelector(".ai-spark");
  spark.setAttribute("role", "button");
  spark.setAttribute("tabindex", "0");
  spark.title = "Contraer Assistant";
  const savedWindow = JSON.parse(localStorage.getItem("paper.ai-window") || "null");
  const savedIsland = JSON.parse(localStorage.getItem("paper.ai-island") || "null");
  const expandAi = () => {
    card.classList.remove("ai-minimized");
    const saved = JSON.parse(localStorage.getItem("paper.ai-window") || "null") || savedWindow;
    card.style.right = "auto";
    card.style.bottom = "auto";
    if (saved && window.innerWidth > 700) {
      card.classList.add("ai-positioned");
      card.style.setProperty("left", `${Math.max(8, Math.min(window.innerWidth - 140, saved.left))}px`, "important");
      card.style.setProperty("top", `${Math.max(8, Math.min(window.innerHeight - 90, saved.top))}px`, "important");
      card.style.setProperty("right", "auto", "important");
      card.style.setProperty("bottom", "auto", "important");
      if (saved.width) card.style.setProperty("width", `${Math.min(saved.width, window.innerWidth - 16)}px`, "important");
      if (saved.height) card.style.setProperty("height", `${Math.min(saved.height, window.innerHeight - 16)}px`, "important");
    } else if (window.innerWidth <= 700) {
      card.classList.remove("ai-positioned");
      ["left", "top", "right", "bottom", "width", "height"].forEach((property) => card.style.removeProperty(property));
    }
  };
  const minimizeAi = () => {
    if (!card.classList.contains("ai-minimized")) {
      const box = card.getBoundingClientRect();
      localStorage.setItem("paper.ai-window", JSON.stringify({ left: box.left, top: box.top, width: box.width, height: box.height }));
    }
    card.classList.add("ai-minimized");
    card.style.width = "58px";
    card.style.height = "58px";
    card.style.right = "auto";
    card.style.bottom = "auto";
    const position = JSON.parse(localStorage.getItem("paper.ai-island") || "null") || savedIsland;
    card.style.setProperty("left", `${position?.left ?? Math.max(12, window.innerWidth - 82)}px`, "important");
    card.style.setProperty("top", `${position?.top ?? Math.max(72, window.innerHeight - 152)}px`, "important");
    $("captureBtn").classList.add("assistant-on");
  };
  const toggleAiIsland = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    card.classList.contains("ai-minimized") ? expandAi() : minimizeAi();
  };
  card._expandAi = expandAi;
  spark.addEventListener("pointerdown", (event) => event.stopPropagation());
  spark.addEventListener("click", toggleAiIsland);
  spark.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") toggleAiIsland(event);
  });
  if (!$("newAiChat")) {
    const controls = document.createElement("div");
    controls.className = "tool-row ai-head-controls";
    controls.innerHTML = '<select class="field" id="aiScope" aria-label="Ámbito de la consulta"><option value="selection">Selección</option><option value="page">Página actual</option><option value="document">Documento completo</option></select><button class="btn" id="newAiChat" title="Nueva conversación">＋ <span>Nueva</span></button>';
    header.insertBefore(controls, $("closeAiPanel"));
  }
  if (!$("minimizeAi")) {
    const minimize = document.createElement("button");
    minimize.className = "btn icon";
    minimize.id = "minimizeAi";
    minimize.title = "Contraer Assistant";
    minimize.textContent = "−";
    $("closeAiPanel").before(minimize);
    minimize.onclick = minimizeAi;
  }
  $("aiScope").onchange = (event) => {
    aiScope = event.target.value;
    if (aiScope === "document" || aiScope === "page") {
      aiImage = "";
      aiImagePage = 0;
      aiSelection = "";
      $("aiSelectionLabel").textContent = aiScope === "document" ? "Documento completo" : `Página ${currentPage}`;
      $("aiQuote").textContent = aiScope === "document"
        ? "Paper buscará localmente las páginas más relevantes para cada pregunta."
        : "La respuesta usará únicamente el texto extraíble de la página actual.";
      $("aiImagePreview").hidden = true;
      renderAiSources(aiScope === "page" ? [currentPage] : []);
      $("aiPanel").hidden = false;
    } else {
      $("aiSelectionLabel").textContent = aiSelection ? "Fragmento seleccionado" : "Selección";
      $("aiQuote").textContent = aiSelection || "Selecciona texto o usa el recorte para añadir contexto.";
      renderAiSources(aiSelection ? [currentPage] : []);
    }
  };
  if (savedWindow && window.innerWidth > 700) {
    card.classList.add("ai-positioned");
    card.style.setProperty("left", `${Math.max(8, savedWindow.left)}px`, "important");
    card.style.setProperty("top", `${Math.max(8, savedWindow.top)}px`, "important");
    card.style.setProperty("right", "auto", "important");
    card.style.setProperty("bottom", "auto", "important");
    if (savedWindow.width) card.style.width = `${savedWindow.width}px`;
    if (savedWindow.height) card.style.height = `${savedWindow.height}px`;
  }
  let drag = null;
  header.addEventListener("pointerdown", (event) => {
    if (card.classList.contains("ai-minimized") || event.target.closest("button,select,input")) return;
    const box = card.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - box.left, y: event.clientY - box.top };
    card.classList.add("ai-positioned");
    card.style.setProperty("width", `${box.width}px`, "important");
    card.style.setProperty("height", `${box.height}px`, "important");
    card.style.setProperty("right", "auto", "important");
    card.style.setProperty("bottom", "auto", "important");
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  header.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("left", `${Math.max(8, Math.min(window.innerWidth - box.width - 8, event.clientX - drag.x))}px`, "important");
    card.style.setProperty("top", `${Math.max(8, Math.min(window.innerHeight - 64, event.clientY - drag.y))}px`, "important");
  });
  header.addEventListener("pointerup", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    const box = card.getBoundingClientRect();
    localStorage.setItem("paper.ai-window", JSON.stringify({ left: box.left, top: box.top, width: box.width, height: box.height }));
  });
  let islandDrag = null;
  card.addEventListener("pointerdown", (event) => {
    if (!card.classList.contains("ai-minimized")) return;
    const box = card.getBoundingClientRect();
    islandDrag = { id: event.pointerId, x: event.clientX - box.left, y: event.clientY - box.top, startX: event.clientX, startY: event.clientY, moved: false };
    card.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  card.addEventListener("pointermove", (event) => {
    if (!islandDrag || islandDrag.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - islandDrag.startX, event.clientY - islandDrag.startY) > 4) islandDrag.moved = true;
    card.style.setProperty("left", `${Math.max(8, Math.min(window.innerWidth - 66, event.clientX - islandDrag.x))}px`, "important");
    card.style.setProperty("top", `${Math.max(8, Math.min(window.innerHeight - 66, event.clientY - islandDrag.y))}px`, "important");
  });
  card.addEventListener("pointerup", (event) => {
    if (!islandDrag || islandDrag.id !== event.pointerId) return;
    const moved = islandDrag.moved;
    islandDrag = null;
    const box = card.getBoundingClientRect();
    localStorage.setItem("paper.ai-island", JSON.stringify({ left: box.left, top: box.top }));
    if (!moved) expandAi();
  });
  new ResizeObserver(() => {
    if (
      panel.hidden ||
      window.innerWidth <= 700 ||
      card.classList.contains("ai-minimized")
    )
      return;
    const box = card.getBoundingClientRect();
    if (box.width < 420 || box.height < 300) return;
    localStorage.setItem("paper.ai-window", JSON.stringify({ left: box.left, top: box.top, width: box.width, height: box.height }));
  }).observe(card);
  window.addEventListener("resize", () => {
    if (card.classList.contains("ai-minimized")) return;
    if (window.innerWidth <= 700) {
      card.classList.remove("ai-positioned");
      ["left", "top", "right", "bottom", "width", "height"].forEach((property) => card.style.removeProperty(property));
    }
  }, { passive: true });
  $("newAiChat").onclick = () => {
    aiAnswerRaw = "";
    aiMessages = [];
    aiSelection = "";
    aiImage = "";
    aiImagePage = 0;
    const storageKey = aiConversationKey();
    if (storageKey) localStorage.removeItem(storageKey);
    $("aiQuote").textContent = "Selecciona texto, un recorte o consulta el documento.";
    $("aiImagePreview").hidden = true;
    $("aiQuestion").value = "";
    renderAiSources([]);
    renderAiConversation();
    renderAiAnswer();
    aiStatus("Nueva conversación local.");
    $("aiQuestion").focus();
  };
  if (!$("aiCaptureBtn")) {
    const capture = document.createElement("button");
    capture.className = "btn icon";
    capture.id = "aiCaptureBtn";
    capture.title = "Recortar una zona del PDF";
    capture.setAttribute("aria-label", capture.title);
    capture.textContent = "⌗";
    $("askAiSubmit").parentElement.prepend(capture);
    capture.onclick = () => {
      $("aiPanel").hidden = true;
      openCapture();
    };
  }
}
function configureResponsiveUi() {
  if (!$("sidebarBackdrop")) {
    const backdrop = document.createElement("button");
    backdrop.id = "sidebarBackdrop";
    backdrop.className = "sidebar-backdrop";
    backdrop.setAttribute("aria-label", "Cerrar panel lateral");
    document.querySelector(".app").append(backdrop);
    backdrop.onclick = () => document.body.classList.remove("sidebar-open");
  }
  const syncViewport = () => {
    document.body.classList.toggle("is-mobile", window.innerWidth <= 700);
    document.body.classList.toggle("is-tablet", window.innerWidth > 700 && window.innerWidth < 1180);
    if (isDrawerLayout()) document.body.classList.remove("sidebar-collapsed");
    if (window.innerWidth >= 1180) document.body.classList.remove("sidebar-open");
  };
  syncViewport();
  window.addEventListener("resize", syncViewport, { passive: true });
}
function configureFooterIsland() {
  const footer = document.querySelector(".footer");
  if (!footer || $("footerCollapse")) return;
  const collapse = document.createElement("button");
  collapse.id = "footerCollapse";
  collapse.className = "btn footer-collapse";
  collapse.title = "Contraer navegador de páginas";
  collapse.setAttribute("aria-label", collapse.title);
  setIcon(collapse, "chevronDown");
  (footer.querySelector(".right") || footer).append(collapse);
  const setMinimized = (minimized) => {
    footer.classList.toggle("footer-minimized", minimized);
    localStorage.setItem("paper.footer-minimized", String(minimized));
    setIcon(collapse, minimized ? "chevronUp" : "chevronDown");
    collapse.title = minimized ? "Expandir navegador de páginas" : "Contraer navegador de páginas";
    collapse.setAttribute("aria-label", collapse.title);
  };
  collapse.onclick = (event) => {
    event.stopPropagation();
    setMinimized(!footer.classList.contains("footer-minimized"));
  };
  footer.addEventListener("click", () => {
    if (footer.classList.contains("footer-minimized")) setMinimized(false);
  });
  setMinimized(localStorage.getItem("paper.footer-minimized") === "true");
}
document.querySelectorAll("[data-color]").forEach(
  (b) =>
    (b.onclick = () => {
      annotationColor = b.dataset.color;
      document
        .querySelectorAll("[data-color]")
        .forEach((x) => x.classList.toggle("active", x === b));
      refreshInkPreview();
      const colorNames = {
        yellow: "amarillo",
        green: "verde",
        blue: "azul",
        pink: "rosa",
        orange: "naranja",
        purple: "morado",
        red: "rojo",
      };
      toast(`Color ${colorNames[annotationColor] || annotationColor} seleccionado`);
    }),
);
document.querySelectorAll("[data-annotation-filter]").forEach(
  (button) =>
    (button.onclick = () => {
      annotationFilter = button.dataset.annotationFilter;
      renderAnnotationList();
    }),
);
$("markerModeBtn").onclick = () => {
  const strip = $("inkStrip");
  strip.hidden = !strip.hidden;
  $("inkColorCard").hidden = true;
  document.body.classList.toggle("ink-toolbar-open", !strip.hidden);
};
$("eraserModeBtn").onclick = () => toggleEraserMode();
$("inkDrawingLayer").addEventListener("pointerdown", (event) => {
  if (!markerMode || !isDrawingTool() || !currentBook) return;
  const point = pageInkPoint(event);
  inkStroke = { id: event.pointerId, type: inkTool, points: inkTool === "box" || inkTool === "arrow" ? [point, point] : [point] };
  $("inkDrawingLayer").setPointerCapture(event.pointerId);
  paintLiveStroke();
  event.preventDefault();
});
$("inkDrawingLayer").addEventListener("pointermove", (event) => {
  if (!inkStroke || inkStroke.id !== event.pointerId) return;
  const point = pageInkPoint(event);
  if (inkStroke.type === "box" || inkStroke.type === "arrow") inkStroke.points[1] = point;
  else {
    const last = inkStroke.points.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) > 0.0015) inkStroke.points.push(point);
  }
  paintLiveStroke();
});
$("inkDrawingLayer").addEventListener("pointerup", (event) => {
  if (!inkStroke || inkStroke.id !== event.pointerId) return;
  saveInkStroke();
});
$("inkDrawingLayer").addEventListener("pointercancel", () => {
  inkStroke = null;
  paintLiveStroke();
});
$("annotationLayer").addEventListener("click", (event) => {
  const id = event.target.closest("[data-annotation-id]")?.dataset.annotationId;
  if (!id) return;
  if (eraserMode) {
    deleteAnnotation(id);
    return;
  }
  if (annotationSelectMode) openAnnotationEditor(id, event.target.getBoundingClientRect());
});
$("captureBtn").onclick = openAssistantForDocument;
$("captureOverlay").addEventListener("pointerdown", (e) => {
  captureStart = { x: e.clientX, y: e.clientY };
  $("captureOverlay").setPointerCapture(e.pointerId);
  updateCaptureBox(captureStart, captureStart);
});
$("captureOverlay").addEventListener("pointermove", (e) => {
  if (captureStart)
    updateCaptureBox(captureStart, { x: e.clientX, y: e.clientY });
});
$("captureOverlay").addEventListener("pointerup", (e) => {
  if (!captureStart) return;
  const start = captureStart;
  captureStart = null;
  cropPdfCapture(start, { x: e.clientX, y: e.clientY });
});
document
  .querySelectorAll("[data-annotation]")
  .forEach((b) => (b.onclick = () => saveAnnotation(b.dataset.annotation)));
document
  .querySelectorAll("[data-ink-tool]")
  .forEach((b) => (b.onclick = () => {
    setInkTool(b.dataset.inkTool);
    if (!markerMode) toggleMarkerMode();
    $("toolPopover").classList.remove("open");
  }));
$("clearPageNotes").onclick = clearPageAnnotations;
$("copySelectionBtn").onclick = copySelectionText;
$("noteBtn").onclick = openNotePanel;
$("closeNotePanel").onclick = closeNotePanel;
$("saveNote").onclick = saveNote;
$("notePanel").onclick = (e) => {
  if (e.target === $("notePanel")) closeNotePanel();
};
$("noteText").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") saveNote();
};
$("askAiBtn").onclick = openAiAssistant;
$("closeAiPanel").onclick = closeAiAssistant;
$("askAiSubmit").onclick = askLocalAi;
$("cancelAi").onclick = () => aiAbortController?.abort();
$("copyAiAnswer").onclick = copyAiAnswer;
document.querySelectorAll("[data-ai-prompt]").forEach(
  (button) =>
    (button.onclick = () => {
      document
        .querySelectorAll("[data-ai-prompt]")
        .forEach((item) => item.classList.toggle("active", item === button));
      $("aiQuestion").value = button.dataset.aiPrompt;
      askLocalAi();
    }),
);
$("aiPanel").onclick = (e) => {
  if (e.target === $("aiPanel")) closeAiAssistant();
};
$("aiQuestion").onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") askLocalAi();
};
function setUiScale(value) {
  const n = Math.max(0.85, Math.min(1.25, value));
  document.documentElement.style.setProperty("--ui-scale", n);
  localStorage.setItem("paper.ui-scale", n);
}
$("uiSmaller").onclick = () =>
  setUiScale(Number(localStorage.getItem("paper.ui-scale") || 1) - 0.05);
$("uiLarger").onclick = () =>
  setUiScale(Number(localStorage.getItem("paper.ui-scale") || 1) + 0.05);
document.addEventListener("selectionchange", () =>
  requestAnimationFrame(() => {
    paintLiveHighlight();
    showAnnotationActions();
  }),
);
document.addEventListener("pointerup", (e) => {
  if (markerMode && e.target.closest(".textLayer"))
    setTimeout(() => saveAnnotation(inkTool, true), 0);
  if (eraserMode && e.target.closest(".textLayer"))
    setTimeout(() => eraseSelectedAnnotations(true), 0);
});
document.addEventListener("pointerdown", (e) => {
  if (
    !e.target.closest(".annotation-actions") &&
    !e.target.closest(".textLayer")
  )
    hideAnnotationActions();
  if (!e.target.closest(".tool-menu")) {
    $("toolPopover").classList.remove("open");
    $("appearancePopover").classList.remove("open");
  }
  if (
    annotationSelectMode &&
    !e.target.closest("#annotationEditor") &&
    !e.target.closest("[data-annotation-id]")
  ) closeAnnotationEditor();
});
window.addEventListener("keydown", (e) => {
  if (
    (e.key === "Escape" && captureStart !== null) ||
    (e.key === "Escape" && $("captureOverlay").classList.contains("show"))
  ) {
    closeCapture();
    return;
  }
  const commandKey = e.ctrlKey || e.metaKey;
  // Paleta de comandos: disponible incluso escribiendo en un campo.
  if (commandKey && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (commandKey && !e.altKey && e.key.toLowerCase() === "f" && pdfDoc) {
    e.preventDefault();
    openPalette(window.getSelection()?.toString().trim().slice(0, 80) || "");
    return;
  }
  if (!$("palette").hidden || !$("shortcutsPanel").hidden || !$("studyPanel").hidden) {
    if (e.key === "Escape") {
      closePalette();
      closeShortcuts();
      if (!$("studyPanel").hidden) closeStudy();
    }
    return;
  }
  if (e.target.matches?.("input,select,textarea") || e.target.isContentEditable) return;
  if (commandKey && e.key.toLowerCase() === "z" && currentBook) {
    e.preventDefault();
    if (e.shiftKey) redoAnnotation();
    else undoAnnotation();
    return;
  }
  if (commandKey && e.key.toLowerCase() === "y" && currentBook) {
    e.preventDefault();
    redoAnnotation();
    return;
  }
  if (commandKey || (e.altKey && !e.key.startsWith("Arrow"))) return;
  if (e.key === "/") {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    navigateBack();
    return;
  }
  if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    navigateForward();
    return;
  }
  if (rulerOn && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    moveRulerBy(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (autoScroll.on && e.key === " " && !presentationMode) {
    e.preventDefault();
    toggleAutoScrollPause();
    return;
  }
  if (autoScroll.on && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    changeAutoScrollSpeed(e.key === "]" ? 1 : -1);
    return;
  }
  if ((e.key === "g" || e.key === "G") && currentBook) setReadingRuler(!rulerOn);
  if ((e.key === "e" || e.key === "E") && currentBook) {
    e.preventDefault();
    openStudy();
  }
  if ((e.key === "a" || e.key === "A") && currentBook) setAutoScroll(!autoScroll.on);
  if (presentationMode && e.key === " ") {
    e.preventDefault();
    stepPage(1);
    return;
  }
  if (e.key === "ArrowRight" || e.key === "PageDown") stepPage(1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") stepPage(-1);
  if (e.key === "Home") jumpToPage(1);
  if (e.key === "End" && pdfDoc) jumpToPage(pdfDoc.numPages);
  if (e.key === "p" || e.key === "P") togglePresentation();
  if (e.key === "+" || e.key === "=") {
    changeReaderZoom(ZOOM_STEP);
  }
  if (e.key === "-") {
    changeReaderZoom(-ZOOM_STEP);
  }
  if (e.key === "b" || e.key === "B") toggleBookmark();
  if (e.key === "r" || e.key === "R") $("rotateBtn").click();
  if (e.key === "f" || e.key === "F") toggleFocusMode();
  if (e.key === "l" || e.key === "L") setReadingMode(reflowMode ? "pdf" : "reflow");
  if (e.key === "s" || e.key === "S") setAnnotationSelectMode();
  // preventDefault: el carácter no debe acabar escrito en el campo que se enfoca.
  if ((e.key === "n" || e.key === "N") && pdfDoc) {
    e.preventDefault();
    setStickyPlacement(!stickyPlacement);
  }
  if ((e.key === "c" || e.key === "C") && currentBook) {
    e.preventDefault();
    toggleNotebook();
  }
  if (e.key === "Escape" && !$("zoomMenu").hidden) {
    closeZoomMenu();
    return;
  }
  if (e.key === "Escape" && stickyPlacement) {
    setStickyPlacement(false);
    return;
  }
  if (e.key === "Escape") {
    if (presentationMode) {
      exitPresentation();
      return;
    }
    if (document.body.classList.contains("reader-chrome-hidden") && !fullscreenElement())
      setReaderChromeHidden(false);
    hideAnnotationActions();
    if (selectedAnnotationId) closeAnnotationEditor();
    $("toolPopover").classList.remove("open");
  }
});
// Botones laterales del ratón: atrás (3) / adelante (4) en el historial de vistas.
window.addEventListener("mouseup", (e) => {
  if (!pdfDoc) return;
  if (e.button === 3) {
    e.preventDefault();
    navigateBack();
  } else if (e.button === 4) {
    e.preventDefault();
    navigateForward();
  }
});
window.addEventListener("auxclick", (e) => {
  if (pdfDoc && (e.button === 3 || e.button === 4)) e.preventDefault();
});
function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}
function touchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}
let sx = null;
document.addEventListener(
  "touchstart",
  (e) => {
    markReadingActivity();
    if (e.touches.length === 2 && pdfDoc && !reflowMode && e.target.closest("#viewer")) {
      e.preventDefault();
      const midpoint = touchMidpoint(e.touches);
      pinchGesture = {
        distance: Math.max(1, touchDistance(e.touches)),
        startScale: scale,
        nextScale: scale,
        anchor: zoomAnchor(midpoint.x, midpoint.y),
      };
      sx = null;
      const wrap = $("canvasWrap"), rect = wrap.getBoundingClientRect();
      wrap.style.transformOrigin = `${midpoint.x - rect.left}px ${midpoint.y - rect.top}px`;
      wrap.classList.add("pinch-preview");
      document.body.classList.add("pdf-pinching");
      return;
    }
    sx = e.touches.length === 1 && !document.body.classList.contains("ink-drawing-mode")
      ? e.changedTouches[0].clientX
      : null;
  },
  { passive: false },
);
document.addEventListener("touchmove", (e) => {
  if (!pinchGesture || e.touches.length < 2) return;
  e.preventDefault();
  const ratio = touchDistance(e.touches) / pinchGesture.distance;
  pinchGesture.nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchGesture.startScale * ratio));
  $("canvasWrap").style.transform = `scale(${pinchGesture.nextScale / pinchGesture.startScale})`;
  $("zoomLabel").textContent = `${Math.round(pinchGesture.nextScale * 100)}%`;
}, { passive: false });
document.addEventListener(
  "touchend",
  (e) => {
    if (pinchGesture && e.touches.length < 2) {
      e.preventDefault();
      const gesture = pinchGesture;
      pinchGesture = null;
      const wrap = $("canvasWrap");
      wrap.style.transform = "";
      wrap.style.transformOrigin = "";
      wrap.classList.remove("pinch-preview");
      document.body.classList.remove("pdf-pinching");
      sx = null;
      setZoom(gesture.nextScale, gesture.anchor);
      return;
    }
    if (sx == null || !pdfDoc) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 110) {
      dx < 0 ? renderPage(currentPage + 1) : renderPage(currentPage - 1);
    }
    sx = null;
  },
  { passive: false },
);
document.addEventListener("touchcancel", () => {
  pinchGesture = null;
  sx = null;
  $("canvasWrap").style.transform = "";
  $("canvasWrap").style.transformOrigin = "";
  $("canvasWrap").classList.remove("pinch-preview");
  document.body.classList.remove("pdf-pinching");
});
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    refitZoom();
  }, 140);
});
for (const eventName of ["pointerdown", "wheel", "keydown"]) {
  document.addEventListener(eventName, markReadingActivity, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushReadingSession(true);
  else markReadingActivity();
});
window.addEventListener("blur", () => flushReadingSession(true));
window.addEventListener("focus", markReadingActivity);
window.addEventListener("pagehide", () => flushReadingSession(true));
readingStatsRefreshTimer = setInterval(() => flushReadingSession(false), 15_000);

(async function init() {
  if (localStorage.getItem("paper.design-version") !== "4") {
    localStorage.setItem("paper.design-version", "4");
    localStorage.setItem("paper.theme", "light");
  }
  document.documentElement.classList.add("ui4");
  applyInterfaceIcons();
  bindInterfaceV4();
  buildReflowControls();
  buildPageColorControls();
  buildThemeChoices();
  updateFocusButton();
  buildInkPalette();
  configureAiWindow();
  configureFooterIsland();
  configureResponsiveUi();
  setTheme(localStorage.getItem("paper.theme") || "light");
  setUiScale(Number(localStorage.getItem("paper.ui-scale") || 1));
  document.querySelector('[data-color="yellow"]').classList.add("active");
  setInkTool("highlight");
  await setReadingMode(localStorage.getItem("paper.reading-mode") || "pdf");
  const margin = localStorage.getItem("paper.reader-margin") || "normal";
  $("viewer").classList.toggle("margin-compact", margin === "compact");
  $("viewer").classList.toggle("margin-wide", margin === "wide");
  document
    .querySelector(`[data-reader-margin="${margin}"]`)
    ?.classList.add("active");
  await openDb();
  await renderLibrary();
  const books = (await dbAll()).sort((a, b) => b.openedAt - a.openedAt);
  if (books[0]) openStored(books[0].id);
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
