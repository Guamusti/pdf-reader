import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const DB_NAME = "paper-reader-db",
  STORE = "pdfs";
let db = null,
  pdfDoc = null,
  currentBook = null,
  currentPage = 1,
  scale = 1.25,
  rotation = 0,
  renderTask = null,
  isRotating = false,
  searchToken = 0,
  renderToken = 0,
  searchMatches = [],
  searchQuery = "",
  searchIndex = -1,
  annotationColor = "yellow",
  annotationFilter = "all",
  markerMode = false,
  captureStart = null,
  aiImage = "",
  localAiEngine = null,
  localAiLoading = null,
  localAiWorker = null,
  visionAiEngine = null,
  visionAiLoading = null,
  visionAiWorker = null,
  builtInAiSession = null,
  aiSelection = "",
  aiAnswerRaw = "",
  pendingNote = null,
  aiAbortController = null,
  thumbObserver = null,
  thumbQueue = [],
  thumbRunning = 0;

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
  $("library").innerHTML = books.length
    ? books
        .map((b) => {
          const page = Number(localStorage.getItem(key(b.id, "page")) || 1),
            progress = b.pages ? Math.round((page / b.pages) * 100) : 0;
          return `<div class="book-entry"><button class="book ${currentBook?.id === b.id ? "active" : ""}" data-id="${encodeURIComponent(b.id)}"><strong>${escapeHtml(b.name)}</strong><small>${b.pages ? `Página ${page} de ${b.pages} · ${progress}%` : new Date(b.openedAt).toLocaleDateString()}</small></button><button class="btn icon book-remove" data-remove-book="${encodeURIComponent(b.id)}" aria-label="Eliminar ${escapeHtml(b.name)}">×</button></div>`;
        })
        .join("")
    : '<span style="color:var(--muted);font-size:13px">Aún no hay PDFs guardados.</span>';
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
  if (
    !(
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf")
    )
  )
    return toast("Selecciona un PDF");
  showLoader(true, "Guardando PDF…", "Se queda solo en este dispositivo");
  try {
    const id = bookId(file),
      buffer = await file.arrayBuffer();
    await dbPut({
      id,
      name: file.name,
      blob: new Blob([buffer], { type: "application/pdf" }),
      openedAt: Date.now(),
      pages: null,
    });
    await openStored(id);
  } catch (e) {
    console.error(e);
    toast("No se pudo guardar el PDF");
  } finally {
    showLoader(false);
  }
}
async function openStored(id) {
  showLoader(true);
  try {
    const rec = await dbGet(id);
    if (!rec) throw new Error("Documento no encontrado");
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
  $("progressBar").style.width = `${(currentPage / pdfDoc.numPages) * 100}%`;
  $("prevBtn").disabled = currentPage === 1;
  $("nextBtn").disabled = currentPage === pdfDoc.numPages;
  $("viewer").scrollTo({ top: 0, left: 0 });
  await renderTextLayer(page, viewport);
  if (token !== renderToken) return;
  renderAnnotations();
  updateThumbSelection();
  updateOutlineSelection();
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
    card.innerHTML = `<span class="thumb-number">${page}</span>`;
    card.onclick = () => renderPage(page);
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
function annotationStyle(color) {
  return (
    {
      yellow: "rgba(255,213,75,.48)",
      green: "rgba(122,205,142,.44)",
      pink: "rgba(244,131,177,.42)",
    }[color] || "rgba(255,213,75,.48)"
  );
}
function renderAnnotations() {
  const layer = $("annotationLayer");
  layer.innerHTML = "";
  if (!currentBook) return;
  for (const mark of annotations().filter((a) => a.page === currentPage)) {
    for (const rect of mark.rects) {
      const el = document.createElement("i");
      el.className = `annotation ${mark.type}`;
      el.style.left = `${rect.x * 100}%`;
      el.style.top = `${rect.y * 100}%`;
      el.style.width = `${rect.w * 100}%`;
      el.style.height = `${rect.h * 100}%`;
      if (mark.type === "highlight")
        el.style.background = annotationStyle(mark.color);
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
        : all.filter((mark) => mark.type === annotationFilter);
  list.innerHTML = marks.length
    ? marks
        .map(
          (mark) =>
            `<div class="annotation-entry"><button class="bookmark" data-annotation-page="${mark.page}"><strong>${mark.type === "note" ? "Nota" : mark.type === "underline" ? "Subrayado" : "Resaltado"} · página ${mark.page}</strong><small>${escapeHtml(mark.note || mark.text || "Fragmento seleccionado")}</small></button><button class="btn icon annotation-remove" data-remove-annotation="${mark.id}" aria-label="Eliminar anotación">×</button></div>`,
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
    el.className = "live-highlight";
    el.style.left = `${rect.x * 100}%`;
    el.style.top = `${rect.y * 100}%`;
    el.style.width = `${rect.w * 100}%`;
    el.style.height = `${rect.h * 100}%`;
    layer.appendChild(el);
  }
}
function clearLiveHighlight() {
  $("liveHighlightLayer").innerHTML = "";
}
function showAnnotationActions() {
  const rects = selectedRects();
  if (!rects || markerMode) {
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
    text: text?.slice(0, 500) || "",
    rects,
    createdAt: Date.now(),
  });
  setAnnotations(items);
  window.getSelection().removeAllRanges();
  hideAnnotationActions();
  clearLiveHighlight();
  renderAnnotations();
  renderAnnotationList();
  if (!quiet)
    toast(type === "highlight" ? "Texto resaltado" : "Texto subrayado");
  return true;
}
function toggleMarkerMode() {
  markerMode = !markerMode;
  document.body.classList.toggle("marker-mode", markerMode);
  $("markerModeBtn").classList.toggle("active", markerMode);
  $("markerModeBtn").setAttribute("aria-pressed", String(markerMode));
  if (!markerMode) clearLiveHighlight();
  toast(
    markerMode
      ? "Rotulador directo activado: selecciona texto y suelta."
      : "Rotulador directo desactivado",
  );
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
    out = document.createElement("canvas");
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  out
    .getContext("2d")
    .drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  aiImage = out.toDataURL("image/png");
  closeCapture();
  openAiAssistant(true);
}

const BUILTIN_AI_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["es"] }],
  expectedOutputs: [{ type: "text", languages: ["es"] }],
};
function aiStatus(message) {
  $("aiStatus").textContent = message;
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
  aiSelection = (text || "").slice(0, 5000);
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
}
async function inspectVisionCapability() {
  if (!isSecureContext)
    return { ok: false, reason: "La visión local necesita HTTPS." };
  if (!navigator.gpu)
    return {
      ok: false,
      reason: "Este navegador no ofrece WebGPU para ejecutar visión local.",
    };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
      return {
        ok: false,
        reason: "WebGPU está desactivado o tu GPU no es compatible.",
      };
    const storage = await navigator.storage?.estimate?.(),
      free = Math.max(0, (storage?.quota || 0) - (storage?.usage || 0));
    if (free && free < 4_500_000_000)
      return {
        ok: false,
        reason:
          "La visión local necesita aproximadamente 4,5 GB libres en este dispositivo.",
      };
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "No se pudo preparar WebGPU para visión local.",
    };
  }
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
  aiSelection = (text || "").slice(0, 5000);
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
    aiStatus("Comprobando si este dispositivo puede ejecutar visión local…");
    const vision = await inspectVisionCapability();
    aiStatus(
      vision.ok
        ? "Visión local disponible. La primera consulta descargará aproximadamente 4 GB y no enviará la captura a ningún servidor."
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

function showEmpty() {
  $("emptyState").hidden = false;
  $("canvasWrap").hidden = true;
  $("docTitle").textContent = "Paper Reader";
  $("docMeta").textContent = "Tus documentos se quedan en este dispositivo";
  $("pageStatus").textContent = "Sin documento";
  $("pageJump").hidden = true;
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
  if (!isVision && !aiSelection) return;
  button.disabled = true;
  $("cancelAi").hidden = false;
  aiAnswerRaw = "";
  renderAiAnswer();
  aiAbortController = new AbortController();
  try {
    if (isVision) {
      const engine = await getVisionAi();
      aiStatus("Analizando la captura en tu dispositivo…");
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
$("zoomIn").onclick = () => zoom(0.15);
$("zoomOut").onclick = () => zoom(-0.15);
$("fitBtn").onclick = fitWidth;
$("bookmarkBtn").onclick = toggleBookmark;
$("searchBtn").onclick = () => search($("searchInput").value);
$("searchInput").onkeydown = (e) => {
  if (e.key === "Enter") search(e.target.value);
};
$("themeSelect").onchange = (e) => {
  document.documentElement.dataset.theme = e.target.value;
  localStorage.setItem("paper.theme", e.target.value);
};
$("openSidebar").onclick = toggleSidebar;
$("closeSidebar").onclick = () => {
  if (window.innerWidth < 900) document.body.classList.remove("sidebar-open");
  else document.body.classList.add("sidebar-collapsed");
};
$("homeBtn").onclick = () => {
  $("libraryPanel").hidden = false;
  renderLibrary();
};
$("closeLibrary").onclick = () => {
  $("libraryPanel").hidden = true;
};
$("libraryPanel").onclick = (e) => {
  if (e.target === $("libraryPanel")) $("libraryPanel").hidden = true;
};
$("library").addEventListener("click", (e) => {
  if (e.target.closest(".book")) $("libraryPanel").hidden = true;
});
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
$("exportNotes").onclick = exportAnnotations;
$("exportMarkdown").onclick = exportMarkdown;
$("toolsBtn").onclick = () => {
  const pop = $("toolPopover"),
    isOpen = pop.classList.toggle("open");
  $("toolsBtn").setAttribute("aria-expanded", String(isOpen));
};
document.querySelectorAll("[data-color]").forEach(
  (b) =>
    (b.onclick = () => {
      annotationColor = b.dataset.color;
      document
        .querySelectorAll("[data-color]")
        .forEach((x) => x.classList.toggle("active", x === b));
      toast(`Color ${b.textContent.toLowerCase()} seleccionado`);
    }),
);
document.querySelectorAll("[data-annotation-filter]").forEach(
  (button) =>
    (button.onclick = () => {
      annotationFilter = button.dataset.annotationFilter;
      renderAnnotationList();
    }),
);
$("markerModeBtn").onclick = toggleMarkerMode;
$("captureBtn").onclick = openCapture;
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
    setTimeout(() => saveAnnotation("highlight", true), 0);
});
document.addEventListener("pointerdown", (e) => {
  if (
    !e.target.closest(".annotation-actions") &&
    !e.target.closest(".textLayer")
  )
    hideAnnotationActions();
  if (!e.target.closest(".tool-menu"))
    $("toolPopover").classList.remove("open");
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
  (e) => (sx = e.changedTouches[0].clientX),
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
  document.documentElement.dataset.theme =
    localStorage.getItem("paper.theme") || "dark";
  $("themeSelect").value = document.documentElement.dataset.theme;
  setUiScale(Number(localStorage.getItem("paper.ui-scale") || 1));
  document.querySelector('[data-color="yellow"]').classList.add("active");
  await openDb();
  await renderLibrary();
  const books = (await dbAll()).sort((a, b) => b.openedAt - a.openedAt);
  if (books[0]) openStored(books[0].id);
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
