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
  scrubFrame = 0,
  scrubTarget = 1,
  thumbScrubStart = null,
  thumbWasDragged = false;

let inkStroke = null;

let annotationRedo = [];

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
  pdfDoc = null;
  currentBook = rec;
  currentPage = 1;
  reflowMode = true;
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
    $("reflowControls").hidden = !reflowMode;
    document.querySelectorAll("[data-reading-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.readingMode === (reflowMode ? "reflow" : "pdf")),
    );
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    rec.pages = pdfDoc.numPages;
    rec.openedAt = Date.now();
    await dbPut(rec);
    currentBook = rec;
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

async function renderPage(num) {
  if (!pdfDoc) return;
  const token = ++renderToken;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {}
  }
  hideAnnotationActions();
  currentPage = Math.max(1, Math.min(pdfDoc.numPages, num));
  updatePageColor();
  const page = await pdfDoc.getPage(currentPage);
  if (token !== renderToken) return;
  const viewport = page.getViewport({ scale, rotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  await renderTask.promise.catch(() => {});
  if (token !== renderToken) return;
  localStorage.setItem(key(currentBook.id, "page"), String(currentPage));
  localStorage.setItem(key(currentBook.id, "scale"), String(scale));
  localStorage.setItem(key(currentBook.id, "rotation"), String(rotation));
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
  $("viewer").scrollTo({ top: 0, left: 0 });
  await renderTextLayer(page, viewport);
  if (token !== renderToken) return;
  if (reflowMode) await renderReflowPage(page);
  $("canvasWrap").hidden = reflowMode;
  $("reflowReader").hidden = !reflowMode;
  renderAnnotations();
  updateThumbSelection();
  updateOutlineSelection();
  prefetchAdjacentPages(currentPage);
}
function reflowParagraphs(items) {
  const lines = [];
  for (const item of items.filter((entry) => entry.str?.trim())) {
    const x = item.transform?.[4] || 0,
      y = item.transform?.[5] || 0;
    const line = lines.find((entry) => Math.abs(entry.y - y) < 3);
    if (line) line.items.push({ x, text: item.str });
    else lines.push({ y, items: [{ x, text: item.str }] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" "))
    .filter(Boolean);
}
async function renderReflowPage(page) {
  const reader = $("reflowReader");
  const content = await page.getTextContent();
  const lines = reflowParagraphs(content.items);
  if (!lines.length) {
    reader.innerHTML = "<p>Esta página no contiene texto extraíble, así que no se puede maquetar.</p>";
    return;
  }
  reader.replaceChildren(
    ...lines.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      return paragraph;
    }),
  );
}
function prefetchAdjacentPages(pageNumber) {
  if (!pdfDoc) return;
  for (const page of [pageNumber - 1, pageNumber + 1]) {
    if (page >= 1 && page <= pdfDoc.numPages) pdfDoc.getPage(page).catch(() => {});
  }
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
      textContentSource: await page.getTextContent(),
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
  const p = await pdfDoc.getPage(currentPage);
  const base = p.getViewport({ scale: 1, rotation });
  const available = $("viewer").clientWidth - 24;
  scale = Math.max(0.35, Math.min(3, available / base.width));
  renderPage(currentPage);
}
function zoom(delta) {
  scale = Math.max(0.4, Math.min(3.5, scale + delta));
  renderPage(currentPage);
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
function resetThumbnails() {
  thumbObserver?.disconnect();
  thumbObserver = null;
  thumbQueue = [];
  thumbRunning = 0;
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
  if (active && !$("thumbnailRail").hidden)
    active.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
}
function enqueueThumbnail(card) {
  if (card.dataset.ready || card.dataset.queued) return;
  card.dataset.queued = "1";
  thumbQueue.push(card);
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
  try {
    if (!pdfDoc || card.dataset.ready) return;
    card.classList.add("loading");
    const page = await pdfDoc.getPage(Number(card.dataset.page));
    const viewport = page.getViewport({ scale: 0.19, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport })
      .promise;
    card.prepend(canvas);
    card.dataset.ready = "1";
  } catch {
  } finally {
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
  updateThumbSelection();
}
function toggleThumbnails() {
  if (!pdfDoc) return toast("Abre un PDF primero");
  const rail = $("thumbnailRail");
  rail.hidden = !rail.hidden;
  if (!rail.hidden) {
    buildThumbnails();
    requestAnimationFrame(updateThumbSelection);
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
      `## Página ${mark.page} · ${mark.type === "note" ? "Nota" : mark.type === "underline" ? "Subrayado" : "Resaltado"}`,
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

function annotations() {
  return currentBook ? getJSON(key(currentBook.id, "annotations"), []) : [];
}
function setAnnotations(items) {
  if (currentBook) setJSON(key(currentBook.id, "annotations"), items);
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
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", mark.points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", annotationStyle(mark.color, mark.opacity ?? 0.82));
      path.setAttribute("stroke-width", String(mark.width || 3));
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.dataset.annotationId = mark.id;
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
            `<div class="annotation-entry"><button class="bookmark" data-annotation-page="${mark.page}"><strong>${annotationLabel(mark.type)} · página ${mark.page}</strong><small>${escapeHtml(mark.note || mark.text || "Fragmento seleccionado")}</small></button><button class="btn icon annotation-remove" data-remove-annotation="${mark.id}" aria-label="Eliminar anotación">×</button></div>`,
        )
        .join("")
    : `<span style="color:var(--muted);font-size:13px">${all.length ? "No hay anotaciones de este tipo." : "Aún no hay anotaciones."}</span>`;
  document
    .querySelectorAll("[data-annotation-page]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          renderPage(Number(button.dataset.annotationPage))),
    );
  document.querySelectorAll("[data-remove-annotation]").forEach(
    (button) =>
      (button.onclick = () => {
        setAnnotations(
          annotations().filter(
            (mark) => mark.id !== button.dataset.removeAnnotation,
          ),
        );
        renderAnnotations();
        renderAnnotationList();
        toast("Anotación eliminada");
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
  annotationRedo = [];
  setAnnotations(items);
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
  annotationRedo = [];
  setAnnotations(items);
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
  document
    .querySelectorAll("[data-ink-tool]")
    .forEach((button) => button.classList.toggle("active", button.dataset.inkTool === tool));
  const label = ({ highlight: "Marcador", underline: "Subrayador", wavy: "Subrayador ondulado", strike: "Tachado", pen: "Pluma", box: "Recuadro", arrow: "Flecha" })[tool] || "Ink";
  $("markerModeBtn").title = `Aplicar ${label.toLowerCase()} directamente`;
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
  const items = annotations();
  let index = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].page === currentPage) { index = i; break; }
  }
  if (index < 0) return toast("No hay anotaciones que deshacer");
  annotationRedo.push(items.splice(index, 1)[0]);
  setAnnotations(items);
  renderAnnotations();
  renderAnnotationList();
  toast("Anotación deshecha");
}
function redoAnnotation() {
  const mark = annotationRedo.pop();
  if (!mark) return toast("No hay anotaciones que rehacer");
  const items = annotations();
  items.push(mark);
  setAnnotations(items);
  renderAnnotations();
  renderAnnotationList();
  toast("Anotación rehecha");
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
    strip.innerHTML = '<div class="ink-strip-inner"><button data-strip-tool="pen" title="Pluma libre"><span class="tool-glyph pen-glyph">✎</span><i class="tool-color"></i></button><button data-strip-tool="highlight" title="Marcador de texto"><span class="tool-glyph marker-glyph">▰</span><i class="tool-color"></i></button><button data-strip-tool="underline" title="Subrayado recto"><span class="tool-glyph">A</span><i class="tool-line straight"></i></button><button data-strip-tool="wavy" title="Subrayado ondulado"><span class="tool-glyph">A</span><i class="tool-line wavy"></i></button><button data-strip-tool="strike" title="Tachado"><span class="tool-glyph strike-glyph">A</span><i class="tool-line strike-line"></i></button><button data-strip-tool="box" title="Dibujar recuadro"><span class="tool-glyph">□</span></button><button data-strip-tool="arrow" title="Dibujar flecha"><span class="tool-glyph">↗</span></button><button data-strip-note title="Añadir nota al texto"><span class="tool-glyph note-glyph">T+</span></button><button data-strip-eraser title="Goma: toca una anotación"><span class="tool-glyph">⌫</span></button><button data-strip-color title="Color, opacidad y grosor"><i class="ink-dot"></i><i class="ink-dot secondary"></i></button><span class="ink-divider"></span><button data-strip-undo title="Deshacer">↶</button><button data-strip-redo title="Rehacer">↷</button><button data-strip-close title="Contraer Ink">⌃</button></div>';
    $("openSidebar").closest(".toolbar").append(strip);
    const colors = ["yellow", "green", "blue", "pink", "orange", "purple", "red"];
    const colorCard = document.createElement("div");
    colorCard.className = "ink-color-card";
    colorCard.id = "inkColorCard";
    colorCard.hidden = true;
    colorCard.innerHTML = `<div class="ink-card-title">Estilo de tinta</div><div class="ink-color-preview"><i></i></div><span class="ink-control-label">Color sólido</span><div class="ink-color-list strong">${colors.map((color) => `<button data-strip-palette="${color}" data-strip-opacity=".88" style="background:${annotationStyle(color, .88)}" aria-label="${color}"></button>`).join("")}</div><span class="ink-control-label">Color translúcido</span><div class="ink-color-list soft">${colors.map((color) => `<button data-strip-palette="${color}" data-strip-opacity=".42" style="background:${annotationStyle(color, .42)}" aria-label="${color} suave"></button>`).join("")}</div><span class="ink-control-label">Grosor del trazo</span><div class="ink-width-list"><button data-ink-width="1"><i></i><span>Fino</span></button><button data-ink-width="3"><i></i><span>Medio</span></button><button data-ink-width="6"><i></i><span>Grueso</span></button></div>`;
    $("openSidebar").closest(".toolbar").append(colorCard);
    const updateStrip = () => {
      strip.style.setProperty("--ink-dot", annotationStyle(annotationColor, inkOpacity));
      strip.querySelector(".ink-dot").style.setProperty("--ink-dot", annotationStyle(annotationColor, inkOpacity));
      strip.querySelectorAll("[data-strip-tool]").forEach((button) => button.classList.toggle("active", button.dataset.stripTool === inkTool && markerMode));
      strip.dataset.activeTool = ({ pen: "Pluma", highlight: "Marcador", underline: "Subrayado", wavy: "Ondulado", strike: "Tachado", box: "Recuadro", arrow: "Flecha" })[inkTool] || "Ink";
    };
    strip.querySelectorAll("[data-strip-tool]").forEach((button) => (button.onclick = () => { setInkTool(button.dataset.stripTool); if (!markerMode) toggleMarkerMode(); updateStrip(); }));
    strip.querySelector("[data-strip-eraser]").onclick = () => { toggleEraserMode(); updateStrip(); };
    strip.querySelector("[data-strip-note]").onclick = () => { if (markerMode) toggleMarkerMode(); toast("Selecciona texto y pulsa Nota en el menú contextual."); };
    strip.querySelector("[data-strip-color]").onclick = () => { colorCard.hidden = !colorCard.hidden; };
    strip.querySelector("[data-strip-undo]").onclick = undoAnnotation;
    strip.querySelector("[data-strip-redo]").onclick = redoAnnotation;
    colorCard.querySelectorAll("[data-strip-palette]").forEach((button) => (button.onclick = () => { annotationColor = button.dataset.stripPalette; inkOpacity = Number(button.dataset.stripOpacity); localStorage.setItem("paper.ink-opacity", String(inkOpacity)); refreshInkPreview(); updateStrip(); updateInkColorCard(); syncInkInteractionMode(); toast("Color de tinta actualizado"); }));
    colorCard.querySelectorAll("[data-ink-width]").forEach((button) => (button.onclick = () => { inkWidth = Number(button.dataset.inkWidth); localStorage.setItem("paper.ink-width", String(inkWidth)); updateInkColorCard(); syncInkInteractionMode(); toast(`Trazo ${inkWidth === 1 ? "fino" : inkWidth === 3 ? "medio" : "grueso"}`); }));
    const updateInkColorCard = () => {
      colorCard.querySelector(".ink-color-preview i").style.setProperty("--ink-card-color", annotationStyle(annotationColor, inkOpacity));
      colorCard.querySelector(".ink-color-preview i").style.height = `${Math.max(3, inkWidth * 2)}px`;
      colorCard.querySelectorAll("[data-strip-palette]").forEach((button) => button.classList.toggle("active", button.dataset.stripPalette === annotationColor && Number(button.dataset.stripOpacity) === inkOpacity));
      colorCard.querySelectorAll("[data-ink-width]").forEach((button) => button.classList.toggle("active", Number(button.dataset.inkWidth) === inkWidth));
    };
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
  setAnnotations(kept);
  window.getSelection().removeAllRanges();
  clearLiveHighlight();
  renderAnnotations();
  renderAnnotationList();
  if (!quiet) toast(`${erased} anotación${erased === 1 ? " eliminada" : "es eliminadas"}`);
  return true;
}
function toggleEraserMode(force) {
  eraserMode = typeof force === "boolean" ? force : !eraserMode;
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
  setAnnotations(existing.filter((a) => a.page !== currentPage));
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
  setAnnotations(items);
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
  $("captureBtn").classList.add("assistant-on");
  $("captureBtn").textContent = "✦ On";
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
  $("captureBtn").classList.remove("assistant-on");
  $("captureBtn").textContent = "✦";
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
  $("captureBtn").classList.add("assistant-on");
  $("captureBtn").textContent = "✦ On";
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
  const page = await pdfDoc.getPage(currentPage);
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
  if (window.innerWidth < 900) {
    document.body.classList.toggle("sidebar-open");
    return;
  }
  document.body.classList.toggle("sidebar-collapsed");
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
$("zoomIn").onclick = () => zoom(0.15);
$("zoomOut").onclick = () => zoom(-0.15);
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
$("closeSidebar").onclick = () => {
  if (window.innerWidth < 900) document.body.classList.remove("sidebar-open");
  else document.body.classList.add("sidebar-collapsed");
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
function toggleFocusMode() {
  const enabled = document.body.classList.toggle("focus-mode");
  $("focusBtn").textContent = enabled ? "×" : "⛶";
  $("focusBtn").title = enabled ? "Salir del modo enfoque" : "Modo enfoque";
  $("focusBtn").setAttribute("aria-label", $("focusBtn").title);
  if (enabled && pdfDoc) fitWidth();
}
$("focusBtn").onclick = toggleFocusMode;
$("pageJump").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) renderPage(page);
  else if (pdfDoc) e.target.value = currentPage;
};
$("pageScrubber").oninput = (e) => scheduleScrubPage(Number(e.target.value));
$("exportNotes").onclick = exportAnnotations;
$("exportMarkdown").onclick = exportMarkdown;
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
$("appearanceZoomIn").onclick = () => zoom(0.15);
$("appearanceZoomOut").onclick = () => zoom(-0.15);
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
  const columns = localStorage.getItem("paper.reflow-columns") || "1";
  reader.style.setProperty("--reflow-size", `${size}px`);
  reader.style.setProperty("--reflow-leading", spacing === "compact" ? "1.35" : spacing === "relaxed" ? "1.95" : "1.65");
  reader.classList.toggle("font-serif", font === "serif");
  reader.classList.toggle("font-mono", font === "mono");
  reader.classList.toggle("columns-2", columns === "2");
  $("reflowFont").value = font;
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => button.classList.toggle("active", button.dataset.reflowSpacing === spacing));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => button.classList.toggle("active", button.dataset.reflowColumns === columns));
}
async function setReadingMode(mode) {
  reflowMode = mode === "reflow";
  localStorage.setItem("paper.reading-mode", mode);
  $("reflowControls").hidden = !reflowMode;
  document.querySelectorAll("[data-reading-mode]").forEach((button) => button.classList.toggle("active", button.dataset.readingMode === mode));
  if (reflowMode) applyReflowPreferences();
  if (pdfDoc) await renderPage(currentPage);
  if (reflowMode) toast("Modo lectura: texto recompuesto de la página actual.");
}
function buildReflowControls() {
  const popover = $("appearancePopover");
  if (!popover || $("reflowControls")) return;
  popover.insertAdjacentHTML("beforeend", `<div class="label">Modo</div><div class="tool-row"><button class="btn" data-reading-mode="pdf">PDF</button><button class="btn" data-reading-mode="reflow">Lectura</button></div><div class="reflow-controls" id="reflowControls" hidden><div class="label">Fuente y tamaño</div><div class="tool-row"><select class="field" id="reflowFont"><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select><button class="btn" id="reflowSmaller">A−</button><button class="btn" id="reflowLarger">A+</button></div><div class="label">Espaciado</div><div class="tool-row"><button class="btn" data-reflow-spacing="compact">Compacto</button><button class="btn" data-reflow-spacing="normal">Normal</button><button class="btn" data-reflow-spacing="relaxed">Amplio</button></div><div class="label">Columnas</div><div class="tool-row"><button class="btn" data-reflow-columns="1">Una</button><button class="btn" data-reflow-columns="2">Dos</button></div></div>`);
  document.querySelectorAll("[data-reading-mode]").forEach((button) => (button.onclick = () => setReadingMode(button.dataset.readingMode)));
  $("reflowFont").onchange = (event) => { localStorage.setItem("paper.reflow-font", event.target.value); applyReflowPreferences(); };
  $("reflowSmaller").onclick = () => { localStorage.setItem("paper.reflow-size", Math.max(14, Number(localStorage.getItem("paper.reflow-size") || 20) - 1)); applyReflowPreferences(); };
  $("reflowLarger").onclick = () => { localStorage.setItem("paper.reflow-size", Math.min(34, Number(localStorage.getItem("paper.reflow-size") || 20) + 1)); applyReflowPreferences(); };
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-spacing", button.dataset.reflowSpacing); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => (button.onclick = () => { localStorage.setItem("paper.reflow-columns", button.dataset.reflowColumns); applyReflowPreferences(); }));
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
  footer.append(collapse);
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
  if (!eraserMode) return;
  const id = event.target.closest("[data-annotation-id]")?.dataset.annotationId;
  if (!id) return;
  setAnnotations(annotations().filter((mark) => mark.id !== id));
  renderAnnotations();
  renderAnnotationList();
  toast("Anotación borrada");
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
  if (e.key === "+" || e.key === "=") zoom(0.15);
  if (e.key === "-") zoom(-0.15);
  if (e.key === "b" || e.key === "B") toggleBookmark();
  if (e.key === "r" || e.key === "R") $("rotateBtn").click();
  if (e.key === "f" || e.key === "F") toggleFocusMode();
  if (e.key === "Escape") {
    if (document.body.classList.contains("focus-mode")) toggleFocusMode();
    hideAnnotationActions();
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
  $("toolbarPrev").textContent = "‹";
  $("toolbarNext").textContent = "›";
  $("prevBtn").textContent = "‹";
  $("nextBtn").textContent = "›";
  buildReflowControls();
  buildPageColorControls();
  buildThemeChoices();
  buildInkPalette();
  configureAiWindow();
  configureFooterIsland();
  configureResponsiveUi();
  setTheme(localStorage.getItem("paper.theme") || "dark");
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
