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
let layoutRefitTimer = 0;
let pageRenderPending = null;
let pageRenderActive = false;
let pageRenderRequestId = 0;
let navigationDirection = 1;
let prefetchHandle = 0;
const pageProxyCache = new Map();
const textContentCache = new Map();

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.15;
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
  const books = (await dbAll()).sort((a, b) => b.openedAt - a.openedAt);
  const query = ($("librarySearch")?.value || "").trim().toLocaleLowerCase();
  const visibleBooks = query
    ? books.filter((book) => book.name.toLocaleLowerCase().includes(query))
    : books;
  if ($("librarySummary")) {
    const pdfs = books.filter((book) => book.kind !== "markdown").length;
    const markdown = books.length - pdfs;
    $("librarySummary").innerHTML = `<strong>${books.length}</strong> documento${books.length === 1 ? "" : "s"}<span>${pdfs} PDF · ${markdown} Markdown</span>`;
  }
  $("library").innerHTML = visibleBooks.length
    ? visibleBooks
        .map((b) => {
          const page = Number(localStorage.getItem(key(b.id, "page")) || 1),
            progress = b.pages ? Math.round((page / b.pages) * 100) : 0;
          const type = b.kind === "markdown" ? "MD" : "PDF";
          return `<article class="book-entry ${currentBook?.id === b.id ? "current" : ""}"><button class="book ${currentBook?.id === b.id ? "active" : ""}" data-id="${encodeURIComponent(b.id)}"><span class="book-cover ${type === "MD" ? "markdown" : ""}"><i>${type}</i><b></b><b></b><b></b></span><span class="book-copy"><span class="book-type">${type === "MD" ? "Documento Markdown" : "Documento PDF"}</span><strong>${escapeHtml(b.name)}</strong><small>${b.pages ? `Página ${page} de ${b.pages}` : new Date(b.openedAt).toLocaleDateString()}</small><i class="book-progress"><b style="width:${progress}%"></b></i><span class="book-continue">${currentBook?.id === b.id ? "Abierto ahora" : progress ? "Continuar leyendo →" : "Abrir documento →"}</span></span><em>${progress}%</em></button><button class="btn icon book-remove" data-remove-book="${encodeURIComponent(b.id)}" aria-label="Eliminar ${escapeHtml(b.name)}" title="Eliminar documento">×</button></article>`;
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
  markdownContent = await rec.blob.text();
  resetRenderEngine();
  pdfDoc = null;
  currentBook = rec;
  resetAnnotationHistory();
  currentPage = 1;
  reflowMode = true;
  document.body.classList.add("reflow-mode");
  $("markerModeBtn").disabled = true;
  $("eraserModeBtn").disabled = true;
  rec.openedAt = Date.now();
  rec.pages = 1;
  await dbPut(rec);
  $("emptyState").hidden = true;
  $("canvasWrap").hidden = true;
  $("reflowReader").hidden = false;
  $("reflowReader").innerHTML = markdownToHtml(markdownContent);
  $("docTitle").textContent = rec.name;
  $("docMeta").textContent = "Markdown · guardado localmente";
  $("pageStatus").textContent = "Modo lectura Markdown";
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
}
async function openStored(id) {
  showLoader(true);
  try {
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
    resetAnnotationHistory();
    resetThumbnails();
    searchQuery = "";
    searchMatches = [];
    searchIndex = -1;
    renderSearchResults();
    currentPage = Math.min(
      Number(localStorage.getItem(key(id, "page")) || 1),
      pdfDoc.numPages,
    );
    scale = Number(localStorage.getItem(key(id, "scale")) || 1.25);
    rotation = Number(localStorage.getItem(key(id, "rotation")) || 0) % 360;
    $("emptyState").hidden = true;
    $("canvasWrap").hidden = false;
    $("docTitle").textContent = rec.name;
    $("docMeta").textContent =
      `${pdfDoc.numPages} páginas · guardado localmente`;
    await renderPage(currentPage);
    renderBookmarks();
    renderAnnotationList();
    await renderOutline();
    renderLibrary();
    document.body.classList.remove("sidebar-open");
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
  $("pageStatus").textContent = `Página ${currentPage} de ${pdfDoc.numPages}`;
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
  if (anchor) restoreZoomAnchor(anchor);
  else if (resetScroll) $("viewer").scrollTo({ top: 0, left: 0 });
  await renderTextLayer(page, viewport);
  if (token !== renderToken || requestId !== pageRenderRequestId) return false;
  if (reflowMode) await renderReflowPage(page);
  $("canvasWrap").hidden = reflowMode;
  $("reflowReader").hidden = !reflowMode;
  renderAnnotations();
  updateThumbSelection();
  updateOutlineSelection();
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
    if (scrubTarget !== currentPage) renderPage(scrubTarget);
  });
}
async function renderTextLayer(page, viewport) {
  const layer = $("textLayer");
  layer.replaceChildren();
  layer.style.width = `${viewport.width}px`;
  layer.style.height = `${viewport.height}px`;
  layer.style.setProperty("--scale-factor", String(viewport.scale));
  try {
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: await getCachedTextContent(page),
      container: layer,
      viewport,
    });
    await textLayer.render();
    paintSearchHits();
  } catch (e) {
    console.error("No se pudo crear la capa de texto", e);
  }
}
function paintSearchHits() {
  if (!searchQuery) return;
  document
    .querySelectorAll("#textLayer span")
    .forEach((span) =>
      span.classList.toggle(
        "search-hit",
        span.textContent.toLowerCase().includes(searchQuery),
      ),
    );
}

async function fitWidth() {
  if (!pdfDoc) return;
  const p = await getCachedPage(currentPage);
  const base = p.getViewport({ scale: 1, rotation });
  const available = $("viewer").clientWidth - 24;
  scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, available / base.width));
  await renderPage(currentPage, { resetScroll: false });
  updateZoomLabel();
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
  label.textContent = `${percent}%`;
  label.title = `Zoom ${percent}% · pulsar para ajustar a la ventana`;
  label.setAttribute("aria-label", label.title);
}
async function zoom(delta, anchor = null) {
  if (!pdfDoc || reflowMode) return;
  const next = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale + delta)) * 100) / 100;
  if (next === scale) return;
  scale = next;
  updateZoomLabel();
  await renderPage(currentPage, { anchor, resetScroll: false });
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
    .forEach((b) => (b.onclick = () => renderPage(Number(b.dataset.p))));
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
}
async function renderOutline() {
  const root = $("outlineList");
  root.innerHTML = "";
  if (!pdfDoc) return;
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline?.length) {
      root.innerHTML =
        '<span style="color:var(--muted);font-size:13px">Este PDF no incluye índice.</span>';
      return;
    }
    const resolvePage = async (item) => {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
      if (!Array.isArray(dest) || !dest[0]) return null;
      return (await pdfDoc.getPageIndex(dest[0])) + 1;
    };
    const addItems = async (items, depth = 0) => {
      for (const item of items) {
        const page = await resolvePage(item);
        const button = document.createElement("button");
        button.className = "outline-item";
        button.style.marginLeft = `${depth * 10}px`;
        if (page) button.dataset.page = page;
        button.innerHTML = `<i class="outline-dot"></i><span class="outline-name">${escapeHtml(item.title || "Sin título")}</span>${page ? `<span class="outline-page">${page}</span>` : ""}`;
        button.onclick = () => {
          if (page) renderPage(page);
          else toast("No se pudo abrir esta sección");
        };
        root.appendChild(button);
        if (item.items?.length) await addItems(item.items, depth + 1);
      }
    };
    await addItems(outline);
    updateOutlineSelection();
  } catch {
    root.innerHTML =
      '<span style="color:var(--muted);font-size:13px">No se pudo leer el índice.</span>';
  }
}
function updateOutlineSelection() {
  const items = [...document.querySelectorAll(".outline-item[data-page]")];
  let active = null;
  for (const item of items)
    if (Number(item.dataset.page) <= currentPage) active = item;
  items.forEach((item) => item.classList.toggle("active", item === active));
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
      renderPage(Number(card.dataset.page));
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
    if (card) renderPage(Number(card.dataset.page));
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
  for (const mark of annotations().sort((a, b) => a.page - b.page)) {
    lines.push(
      `## Página ${mark.page} · ${annotationLabel(mark.type)}`,
      mark.text ? `> ${mark.text}` : "> Fragmento sin texto disponible",
      mark.note ? `\n${mark.note}` : "",
      "",
    );
  }
  downloadText(
    `${currentBook.name.replace(/\.pdf$/i, "")}-anotaciones.md`,
    lines.join("\n"),
    "text/markdown",
  );
  toast("Markdown exportado");
}

const SUPPORTED_ANNOTATION_TYPES = new Set(["highlight", "underline", "wavy", "strike", "note", "pen", "box", "arrow"]);
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
function normalizeImportedAnnotation(mark) {
  if (!mark || !SUPPORTED_ANNOTATION_TYPES.has(mark.type)) return null;
  const page = Math.trunc(Number(mark.page));
  if (!pdfDoc || page < 1 || page > pdfDoc.numPages) return null;
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
async function importAnnotationBackup(file) {
  if (!currentBook || !pdfDoc) return toast("Abre el PDF de destino primero");
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data?.annotations)) throw new Error("Formato no compatible");
    const imported = data.annotations.map(normalizeImportedAnnotation).filter(Boolean);
    if (!imported.length) throw new Error("No contiene anotaciones compatibles");
    commitAnnotations([...annotations(), ...imported]);
    renderAnnotations();
    renderAnnotationList();
    toast(`${imported.length} anotación${imported.length === 1 ? " importada" : "es importadas"}`);
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
          await renderPage(Number(button.dataset.annotationPage));
          openAnnotationEditor(button.dataset.annotationId);
        }),
    );
  document.querySelectorAll("[data-remove-annotation]").forEach(
    (button) =>
      (button.onclick = () => {
        deleteAnnotation(button.dataset.removeAnnotation);
      }),
  );
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
    strip.innerHTML = '<div class="ink-strip-inner"><button class="ink-drag-handle" data-strip-drag title="Mover barra Ink" aria-label="Mover barra Ink">⠿</button><button data-strip-select title="Seleccionar y editar anotación" aria-label="Seleccionar anotación">↖</button><button data-strip-tool="pen" title="Pluma libre"><span class="tool-glyph pen-glyph">✎</span><i class="tool-color"></i></button><button data-strip-tool="highlight" title="Marcador de texto"><span class="tool-glyph marker-glyph">▰</span><i class="tool-color"></i></button><button data-strip-tool="underline" title="Subrayado recto"><span class="tool-glyph">A</span><i class="tool-line straight"></i></button><button data-strip-tool="wavy" title="Subrayado ondulado"><span class="tool-glyph">A</span><i class="tool-line wavy"></i></button><button data-strip-tool="strike" title="Tachado"><span class="tool-glyph strike-glyph">A</span><i class="tool-line strike-line"></i></button><button data-strip-tool="box" title="Dibujar recuadro"><span class="tool-glyph">□</span><i class="tool-color"></i></button><button data-strip-tool="arrow" title="Dibujar flecha"><span class="tool-glyph">↗</span><i class="tool-color"></i></button><button data-strip-note title="Añadir nota al texto"><span class="tool-glyph note-glyph">T+</span></button><button data-strip-eraser title="Goma: toca una anotación"><span class="tool-glyph">⌫</span></button><button data-strip-color title="Estilo de la herramienta actual"><i class="ink-dot"></i><i class="ink-dot secondary"></i></button><span class="ink-divider"></span><button data-strip-undo title="Deshacer">↶</button><button data-strip-redo title="Rehacer">↷</button><button data-strip-close title="Contraer Ink">⌃</button></div>';
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
    strip.querySelector("[data-strip-note]").onclick = () => { if (markerMode) toggleMarkerMode(); toast("Selecciona texto y pulsa Nota en el menú contextual."); };
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
function openCapture() {
  if (!pdfDoc) return toast("Abre un PDF primero");
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
  button.innerHTML = active
    ? '✦ <span>Activo</span>'
    : '✦ <span>Asistente</span>';
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
  $("aiScope").value = "document";
  $("aiSelectionLabel").textContent = "Documento";
  $("aiQuote").textContent = "Pregunta sobre el documento; se usará el contexto de la página actual.";
  $("aiImagePreview").hidden = true;
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
    return { ok: true, kind: "webllm", availability: "downloadable" };
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
  const answer = aiAnswerRaw.trim();
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
async function getWebLlmAi() {
  if (localAiEngine) return localAiEngine;
  if (localAiLoading) return localAiLoading;
  localAiLoading = (async () => {
    aiStatus("Preparando motor de IA local…");
    const webllm = await import("https://esm.run/@mlc-ai/web-llm@0.2.84");
    localAiWorker = new Worker("/ai-worker.js?v=1", { type: "module" });
    localAiEngine = await webllm.CreateWebWorkerMLCEngine(
      localAiWorker,
      "Llama-3.2-1B-Instruct-q4f16_1-MLC",
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
    visionAiWorker = new Worker("/ai-worker.js?v=1", { type: "module" });
    visionAiEngine = await webllm.CreateWebWorkerMLCEngine(
      visionAiWorker,
      "Phi-3.5-vision-instruct-q4f16_1-MLC",
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
  if (!fromCapture) aiImage = "";
  aiSelection = (text || "").slice(0, 5000);
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
  if (!pdfDoc) return "";
  const page = await getCachedPage(currentPage);
  const content = await page.getTextContent();
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
      for await (const chunk of session.promptStreaming(prompt, {
        signal: aiAbortController.signal,
      }))
        appendAiChunk(chunk);
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
  if (!searchMatches.length) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = searchMatches
    .map(
      (match, index) =>
        `<button class="bookmark ${index === searchIndex ? "active" : ""}" data-search-index="${index}"><strong>Página ${match.page}</strong><small>${escapeHtml(match.snippet)}</small></button>`,
    )
    .join("");
  document.querySelectorAll("[data-search-index]").forEach(
    (button) =>
      (button.onclick = async () => {
        searchIndex = Number(button.dataset.searchIndex);
        await renderPage(searchMatches[searchIndex].page);
        renderSearchResults();
      }),
  );
}
async function search(query) {
  if (!pdfDoc || !query.trim()) return;
  const q = query.trim().toLowerCase();
  if (q === searchQuery && searchMatches.length) {
    searchIndex = (searchIndex + 1) % searchMatches.length;
    await renderPage(searchMatches[searchIndex].page);
    renderSearchResults();
    toast(
      `Coincidencia ${searchIndex + 1} de ${searchMatches.length} · página ${currentPage}`,
    );
    return;
  }
  const token = ++searchToken;
  searchQuery = q;
  searchMatches = [];
  searchIndex = -1;
  showLoader(true, "Buscando…", `“${query.trim()}”`);
  try {
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== searchToken) return;
      const p = await pdfDoc.getPage(i);
      const tc = await p.getTextContent();
      const text = tc.items.map((x) => x.str).join(" ");
      const at = text.toLowerCase().indexOf(q);
      if (at >= 0)
        searchMatches.push({
          page: i,
          snippet: text
            .slice(Math.max(0, at - 42), at + q.length + 72)
            .replace(/\s+/g, " ")
            .trim(),
        });
      $("loaderText").textContent = `Página ${i} de ${pdfDoc.numPages}`;
    }
    if (!searchMatches.length) {
      renderSearchResults();
      toast("No se encontró el texto");
      return;
    }
    const afterCurrent = searchMatches.findIndex(
      (match) => match.page >= currentPage,
    );
    searchIndex = afterCurrent < 0 ? 0 : afterCurrent;
    await renderPage(searchMatches[searchIndex].page);
    renderSearchResults();
    toast(
      `Coincidencia ${searchIndex + 1} de ${searchMatches.length} · página ${currentPage}`,
    );
  } finally {
    showLoader(false);
  }
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
  $("emptyState").hidden = false;
  $("canvasWrap").hidden = true;
  $("reflowReader").hidden = true;
  $("docTitle").textContent = "Paper Reader";
  $("docMeta").textContent = "Tus documentos se quedan en este dispositivo";
  $("pageStatus").textContent = "Sin documento";
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
  searchMatches = [];
  renderSearchResults();
  resetThumbnails();
  renderBookmarks();
}

async function askLocalAi() {
  const isVision = Boolean(aiImage && !aiSelection),
    button = $("askAiSubmit"),
    question =
      $("aiQuestion").value.trim() ||
      (isVision ? "Describe esta captura." : "Explica este texto.");
  if (!isVision && !aiSelection && aiScope !== "document") return;
  const answerBeforeRequest = aiAnswerRaw;
  button.disabled = true;
  $("cancelAi").hidden = false;
  aiAnswerRaw += `${aiAnswerRaw.trim() ? "\n\n---\n\n" : ""}**Tú:** ${question}\n\n**Assistant:** `;
  renderAiAnswer();
  aiAbortController = new AbortController();
  try {
    if (isVision) {
      const vision = await inspectVisionCapability();
      if (!vision.ok) throw new Error(vision.reason);
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
                { type: "text", value: question },
                { type: "image", value: imageBlob },
              ],
            },
          ];
          for await (const chunk of session.promptStreaming(prompt, {
            signal: aiAbortController.signal,
          }))
            appendAiChunk(chunk);
        } catch (builtInError) {
          builtInVisionSession = null;
          console.warn(
            "La visión integrada falló; se intenta WebGPU",
            builtInError,
          );
          aiStatus("La visión integrada no respondió. Probando WebGPU…");
          await streamWebLlmVision(question);
        }
      } else {
        await streamWebLlmVision(question);
      }
    } else {
      const capability = await inspectAiCapability();
      if (capability.kind === "none") throw new Error(capability.reason);
      const context = await pageContext();
      const prompt = `Actúa como un asistente de lectura riguroso y responde siempre en español. Usa solo el texto proporcionado; si falta información, indícalo.\n\nFragmento seleccionado:\n---\n${aiSelection}\n---\n\nContexto de la página:\n---\n${context}\n---\n\nPregunta: ${question}`;
      if (capability.kind === "builtin") {
        const session = await getBuiltInAi();
        aiStatus("Pensando en tu dispositivo…");
        for await (const chunk of session.promptStreaming(prompt, {
          signal: aiAbortController.signal,
        }))
          appendAiChunk(chunk);
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
    }
    aiStatus(
      "Respuesta generada localmente. El documento no ha salido de tu navegador.",
    );
    $("copyAiAnswer").hidden = !aiAnswerRaw.trim();
  } catch (e) {
    if (e.name === "AbortError") {
      aiAnswerRaw = answerBeforeRequest;
      renderAiAnswer();
      aiStatus("Consulta detenida.");
      return;
    }
    console.error(e);
    aiAnswerRaw = answerBeforeRequest;
    renderAiAnswer();
    aiStatus(friendlyAiError(e, isVision));
  } finally {
    button.disabled = false;
    $("cancelAi").hidden = true;
    aiAbortController = null;
  }
}
function toggleSidebar() {
  if (window.innerWidth <= 900) {
    document.body.classList.toggle("sidebar-open");
    return;
  }
  document.body.classList.toggle("sidebar-collapsed");
  scheduleLayoutRefit();
}
function scheduleLayoutRefit() {
  clearTimeout(layoutRefitTimer);
  if (pdfDoc) requestAnimationFrame(fitWidth);
  layoutRefitTimer = setTimeout(() => {
    if (pdfDoc) fitWidth();
  }, 240);
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
$("prevBtn").onclick = () => renderPage(currentPage - 1);
$("nextBtn").onclick = () => renderPage(currentPage + 1);
$("toolbarPrev").onclick = () => renderPage(currentPage - 1);
$("toolbarNext").onclick = () => renderPage(currentPage + 1);
$("toolbarPage").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) renderPage(page);
  else e.target.value = currentPage;
};
$("zoomIn").onclick = () => zoom(ZOOM_STEP);
$("zoomOut").onclick = () => zoom(-ZOOM_STEP);
$("zoomLabel").onclick = fitWidth;
$("fitBtn").onclick = fitWidth;
$("toolbarFitBtn").onclick = fitWidth;
$("bookmarkBtn").onclick = toggleBookmark;
$("searchBtn").onclick = () => search($("searchInput").value);
$("searchInput").onkeydown = (e) => {
  if (e.key === "Enter") search(e.target.value);
};
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
  if (window.innerWidth <= 900) document.body.classList.remove("sidebar-open");
  else {
    document.body.classList.add("sidebar-collapsed");
    scheduleLayoutRefit();
  }
};
$("homeBtn").onclick = () => {
  $("libraryPanel").hidden = false;
  renderLibrary();
};
$("emptyLibraryBtn").onclick = $("homeBtn").onclick;
$("closeLibrary").onclick = () => {
  $("libraryPanel").hidden = true;
};
$("libraryPanel").onclick = (e) => {
  if (e.target === $("libraryPanel")) $("libraryPanel").hidden = true;
};
$("library").addEventListener("click", (e) => {
  if (e.target.closest(".book")) $("libraryPanel").hidden = true;
});
$("librarySearch").addEventListener("input", renderLibrary);
$("rotateBtn").onclick = async () => {
  if (!pdfDoc || isRotating) return;
  isRotating = true;
  const button = $("rotateBtn"),
    wasOpen = !$("thumbnailRail").hidden;
  button.disabled = true;
  try {
    rotation = (rotation + 90) % 360;
    resetThumbnails();
    await renderPage(currentPage);
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
  button.textContent = active ? "×" : "⛶";
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
  if (refit && pdfDoc) requestAnimationFrame(fitWidth);
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
  if (pdfDoc) requestAnimationFrame(fitWidth);
}
function syncFullscreenState() {
  const active = Boolean(fullscreenElement());
  document.body.classList.toggle("focus-mode", active);
  if (!active) setReaderChromeHidden(false, false);
  updateFocusButton(active);
  if (pdfDoc) requestAnimationFrame(fitWidth);
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
  setReaderChromeHidden(!document.body.classList.contains("reader-chrome-hidden"));
});
$("pageJump").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) renderPage(page);
  else if (pdfDoc) e.target.value = currentPage;
};
$("pageScrubber").oninput = (e) => scheduleScrubPage(Number(e.target.value));
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
$("appearanceZoomIn").onclick = () => zoom(ZOOM_STEP);
$("appearanceZoomOut").onclick = () => zoom(-ZOOM_STEP);
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
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => button.classList.toggle("active", button.dataset.reflowSpacing === spacing));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => button.classList.toggle("active", button.dataset.reflowColumns === columns));
  document.querySelectorAll("[data-reflow-width]").forEach((button) => button.classList.toggle("active", button.dataset.reflowWidth === width));
  document.querySelectorAll("[data-reflow-tracking]").forEach((button) => button.classList.toggle("active", button.dataset.reflowTracking === tracking));
  document.querySelectorAll("[data-reflow-alignment]").forEach((button) => button.classList.toggle("active", button.dataset.reflowAlignment === alignment));
  document.querySelectorAll("[data-reflow-theme]").forEach((button) => button.classList.toggle("active", button.dataset.reflowTheme === theme));
}
async function setReadingMode(mode) {
  reflowMode = mode === "reflow";
  localStorage.setItem("paper.reading-mode", mode);
  document.body.classList.toggle("reflow-mode", reflowMode);
  $("markerModeBtn").disabled = reflowMode;
  $("eraserModeBtn").disabled = reflowMode;
  $("reflowControls").hidden = !reflowMode;
  document.querySelectorAll("[data-reading-mode]").forEach((button) => button.classList.toggle("active", button.dataset.readingMode === mode));
  if (reflowMode) applyReflowPreferences();
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
    if (saved) {
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
    controls.innerHTML = '<select class="field" id="aiScope" aria-label="Ámbito de la consulta"><option value="selection">Selección</option><option value="document">Documento</option></select><button class="btn" id="newAiChat" title="Nueva conversación">＋ <span>Nueva</span></button>';
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
    if (aiScope === "document") {
      aiImage = "";
      aiSelection = "";
      $("aiSelectionLabel").textContent = "Documento";
      $("aiQuote").textContent = "Consulta sobre el documento; se usará el contexto de la página actual.";
      $("aiImagePreview").hidden = true;
      $("aiPanel").hidden = false;
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
  $("newAiChat").onclick = () => {
    aiAnswerRaw = "";
    aiSelection = "";
    aiImage = "";
    $("aiQuote").textContent = "Selecciona texto, un recorte o consulta el documento.";
    $("aiImagePreview").hidden = true;
    $("aiQuestion").value = "";
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
    if (window.innerWidth <= 900) document.body.classList.remove("sidebar-collapsed");
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
  collapse.textContent = "⌄";
  (footer.querySelector(".right") || footer).append(collapse);
  const setMinimized = (minimized) => {
    footer.classList.toggle("footer-minimized", minimized);
    localStorage.setItem("paper.footer-minimized", String(minimized));
    collapse.textContent = minimized ? "⌃" : "⌄";
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
  if (e.target.matches?.("input,select,textarea")) return;
  if (e.key === "ArrowRight" || e.key === "PageDown")
    renderPage(currentPage + 1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") renderPage(currentPage - 1);
  if (e.key === "Home") renderPage(1);
  if (e.key === "End" && pdfDoc) renderPage(pdfDoc.numPages);
  if (e.key === "+" || e.key === "=") {
    if (reflowMode) {
      localStorage.setItem("paper.reflow-size", Math.min(36, Number(localStorage.getItem("paper.reflow-size") || 20) + 1));
      applyReflowPreferences();
    } else zoom(ZOOM_STEP);
  }
  if (e.key === "-") {
    if (reflowMode) {
      localStorage.setItem("paper.reflow-size", Math.max(14, Number(localStorage.getItem("paper.reflow-size") || 20) - 1));
      applyReflowPreferences();
    } else zoom(-ZOOM_STEP);
  }
  if (e.key === "b" || e.key === "B") toggleBookmark();
  if (e.key === "r" || e.key === "R") $("rotateBtn").click();
  if (e.key === "f" || e.key === "F") toggleFocusMode();
  if (e.key === "l" || e.key === "L") setReadingMode(reflowMode ? "pdf" : "reflow");
  if (e.key === "s" || e.key === "S") setAnnotationSelectMode();
  if (e.key === "Escape") {
    if (document.body.classList.contains("reader-chrome-hidden") && !fullscreenElement())
      setReaderChromeHidden(false);
    hideAnnotationActions();
    if (selectedAnnotationId) closeAnnotationEditor();
    $("toolPopover").classList.remove("open");
  }
});
let sx = null;
document.addEventListener(
  "touchstart",
  (e) => (sx = document.body.classList.contains("ink-drawing-mode") ? null : e.changedTouches[0].clientX),
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e) => {
    if (sx == null || !pdfDoc) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 110) {
      dx < 0 ? renderPage(currentPage + 1) : renderPage(currentPage - 1);
    }
    sx = null;
  },
  { passive: true },
);
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (
      pdfDoc &&
      (window.innerWidth < 900 ||
        document.body.classList.contains("focus-mode"))
    )
      fitWidth();
  }, 140);
});

(async function init() {
  if (localStorage.getItem("paper.design-version") !== "4") {
    localStorage.setItem("paper.design-version", "4");
    localStorage.setItem("paper.theme", "light");
  }
  $("toolbarPrev").textContent = "‹";
  $("toolbarNext").textContent = "›";
  $("prevBtn").textContent = "‹";
  $("nextBtn").textContent = "›";
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
