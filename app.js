import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

import {
  openDatabase,
  KvStore,
  idbRequest,
  idbDone,
  contentId,
  isContentId,
  mergeValue,
  createBackupBlob,
  readBackupBlob,
  backupKind,
  encryptBackupBlob,
  decryptBackupBlob,
} from "./storage.js?v=1";
import { folderSyncSupported, openSyncFolder, syncFolder } from "./sync.js?v=1";
import {
  buildLines,
  extractReferences,
  citationAt,
  findEntryForCitation,
  captionPattern,
  findDoi,
  findArxiv,
  toBibtex,
  toRis,
  bibKey,
  formatCitation,
  metaFromCsl,
  anchorScore,
  anchorProbe,
  STATEMENT_LABELS,
} from "./references.js?v=2";

const $ = (id) => document.getElementById(id);
const STORE = "pdfs";
// Notas, anotaciones, tarjetas, progreso y preferencias: caché síncrona sobre
// IndexedDB (ver storage.js). Se carga antes de cualquier lectura.
const kv = new KvStore();
let db = null;
try {
  db = await openDatabase({
    onBlocked: () => showLoader(true, "Actualizando Paper Reader…", "Cierra las demás pestañas de Paper Reader para continuar"),
  });
  await kv.open(db);
  showLoader(false);
} catch (error) {
  console.error("No se pudo abrir el almacenamiento local", error);
  kv.mode = "local";
}
// Cambios hechos en otra pestaña: se refleja lo que afecta al documento abierto.
kv.onRemoteChange = (keys) => {
  if (currentBook && keys.some((k) => k.startsWith(`paper.${currentBook.id}.`))) refreshCurrentDocumentData();
};
kv.onError = (error) => {
  console.error("No se pudieron guardar los cambios", error);
  toast(error?.name === "QuotaExceededError" ? "No queda espacio para guardar los cambios. Libera espacio o elimina documentos." : "No se pudieron guardar los últimos cambios; se reintentará.", 6000);
};
let pdfDoc = null,
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
  inkOpacity = Number(kv.getItem("paper.ink-opacity") || 0.82),
  inkWidth = Number(kv.getItem("paper.ink-width") || 3),
  annotationFilter = "all",
  inkTool = "highlight",
  markerMode = false,
  eraserMode = false,
  annotationSelectMode = false,
  selectedAnnotationId = null,
  reflowMode = false,
  captureStart = null,
  captureAppend = false,
  captureToBoard = false,
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
  kv.setItem("paper.ink-opacity", String(inkOpacity));
  kv.setItem("paper.ink-width", String(inkWidth));
}

function updateCurrentInkToolStyle(patch) {
  inkToolStyles[inkTool] = { ...inkToolStyles[inkTool], ...patch };
  persistInkToolStyles();
  applyInkToolStyle();
}

function toast(msg, duration = 1600) {
  const e = $("toast");
  e.textContent = msg;
  e.classList.add("show");
  clearTimeout(e.t);
  e.t = setTimeout(() => e.classList.remove("show"), duration);
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
    return JSON.parse(kv.getItem(k) || JSON.stringify(d));
  } catch {
    return d;
  }
}
function setJSON(k, v) {
  kv.setItem(k, JSON.stringify(v));
}
// El id de un documento es la huella SHA-256 de su contenido: renombrarlo o
// volver a descargarlo no separa el PDF de sus anotaciones. Sin WebCrypto (sitio
// sin HTTPS) se recurre al id antiguo por nombre, tamaño y fecha.
async function documentIdFor(buffer, file) {
  try {
    if (globalThis.crypto?.subtle) return await contentId(buffer);
  } catch (error) {
    console.warn("No se pudo calcular la huella del documento", error);
  }
  return `${file.name}:${file.size}:${file.lastModified}`;
}
function documentKeys(id) {
  return kv.keys(`paper.${id}.`);
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
  const page = Math.max(1, Math.min(Number(kv.getItem(key(book.id, "page")) || 1), book.pages || 1));
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
  return db ? Promise.resolve(db) : Promise.reject(new Error("IndexedDB no está disponible"));
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

// Índice de texto por documento: el texto de cada página se extrae una vez y
// se guarda, así las búsquedas (en el documento o en toda la biblioteca), la
// paleta y la IA no vuelven a analizar el PDF.
const TEXT_INDEX_VERSION = 1;
function getTextIndex(id) {
  if (!db) return Promise.resolve(null);
  return idbRequest(db.transaction("texts").objectStore("texts").get(id))
    .then((record) => (record?.v === TEXT_INDEX_VERSION && Array.isArray(record.pages) ? record : null))
    .catch(() => null);
}
async function putTextIndex(id, pages) {
  if (!db) return;
  const tx = db.transaction("texts", "readwrite");
  tx.objectStore("texts").put({ id, v: TEXT_INDEX_VERSION, pages, builtAt: Date.now() });
  await idbDone(tx);
}
async function deleteTextIndex(id) {
  if (!db) return;
  const tx = db.transaction("texts", "readwrite");
  tx.objectStore("texts").delete(id);
  await idbDone(tx).catch(() => {});
}
async function extractDocumentText(doc, { onProgress, isCancelled } = {}) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled?.()) return null;
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
    } catch {
      pages.push("");
    }
    onProgress?.(i, doc.numPages);
    if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return pages;
}
// Texto del documento abierto. `pages` se va rellenando mientras se indexa
// (la paleta muestra resultados parciales) y `complete` indica que está entero.
let docText = { id: "", bookId: "", pages: [], done: 0, complete: false, checked: false, started: false, doc: null };
function currentDocPages() {
  return docText.id === currentBook?.id && docText.complete ? docText.pages : null;
}
async function loadCurrentDocText(rec, doc) {
  const state = { id: rec.id, bookId: rec.id, pages: new Array(doc.numPages).fill(null), done: 0, complete: false, checked: false, started: false, doc };
  docText = state;
  const stored = await getTextIndex(rec.id);
  if (docText !== state) return;
  state.checked = true;
  if (stored && stored.pages.length === doc.numPages) {
    state.pages = stored.pages;
    state.done = doc.numPages;
    state.complete = true;
    state.started = true;
    schedulePaletteRender();
    return;
  }
  // Se construye en segundo plano, sin competir con el primer render (salvo
  // que la paleta ya esté esperando resultados).
  if (!$("palette").hidden) buildDocText(state);
  else if ("requestIdleCallback" in window) requestIdleCallback(() => buildDocText(state), { timeout: 2000 });
  else setTimeout(() => buildDocText(state), 500);
}
function buildDocText(state = docText) {
  if (!state.checked || state.started || !state.doc) return;
  state.started = true;
  (async () => {
    const doc = state.doc;
    for (let i = 1; i <= doc.numPages; i++) {
      if (docText !== state || pdfDoc !== doc) return;
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        state.pages[i - 1] = content.items.map((item) => item.str).join(" ");
      } catch {
        state.pages[i - 1] = "";
      }
      state.done = i;
      if (i % 12 === 0 || i === doc.numPages) schedulePaletteRender();
      if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.complete = true;
    await putTextIndex(state.id, state.pages).catch((error) => console.warn("No se pudo guardar el índice de texto", error));
  })();
}

async function deleteBook(id) {
  if (!confirm("¿Eliminar este PDF y sus datos locales?")) return;
  await removeBook(id);
}
async function removeBook(id, { quiet = false } = {}) {
  await dbDelete(id);
  // Todo lo guardado para este documento: anotaciones, notas, tarjetas,
  // progreso, conversación con la IA, colores de página…
  for (const k of documentKeys(id)) kv.removeItem(k);
  await deleteTextIndex(id);
  if (currentBook?.id === id) {
    resetRenderEngine();
    pdfDoc = null;
    currentBook = null;
    showEmpty();
  }
  await renderLibrary();
  if (!quiet) toast("PDF eliminado de la biblioteca");
}
// ---- Migración: de ids por nombre a ids por contenido ----
// Las versiones anteriores identificaban cada PDF por nombre, tamaño y fecha.
// Al arrancar, cada documento antiguo pasa a su huella SHA-256 junto con todos
// sus datos. Si dos entradas resultan ser el mismo PDF, sus notas se combinan.
async function dbReplaceRecord(oldId, record) {
  const tx = db.transaction(STORE, "readwrite");
  const objects = tx.objectStore(STORE);
  objects.put(record);
  if (oldId !== record.id) objects.delete(oldId);
  await idbDone(tx);
}
function moveDocumentData(oldId, newId) {
  const oldPrefix = `paper.${oldId}.`,
    newPrefix = `paper.${newId}.`;
  const now = Date.now();
  const entries = [];
  for (const k of kv.keys(oldPrefix)) {
    const target = newPrefix + k.slice(oldPrefix.length);
    const incoming = kv.getItem(k);
    const existing = kv.getItem(target);
    entries.push([target, existing === null ? incoming : mergeValue(target, undefined, existing, incoming), now], [k, null, now]);
  }
  return kv.applyEntries(entries).length;
}
async function migrateLegacyDocumentIds() {
  if (!db || !globalThis.crypto?.subtle) return 0;
  const legacy = (await dbAll()).filter((record) => !isContentId(record.id) && record.blob);
  if (!legacy.length) return 0;
  showLoader(true, "Actualizando la biblioteca…", "Identificando cada documento por su contenido");
  let migrated = 0;
  try {
    for (const [index, record] of legacy.entries()) {
      $("loaderText").textContent = `${record.name} · ${index + 1}/${legacy.length}`;
      try {
        const id = await contentId(await record.blob.arrayBuffer());
        const existing = await dbGet(id);
        // Primero los datos (una sola transacción) y después el registro: si
        // algo se interrumpe, la migración se repite sin perder nada.
        moveDocumentData(record.id, id);
        await kv.flush();
        const merged = existing
          ? { ...record, ...existing, id, addedAt: Math.min(existing.addedAt || Date.now(), record.addedAt || Date.now()), openedAt: Math.max(existing.openedAt || 0, record.openedAt || 0) }
          : { ...record, id, size: record.size || record.blob.size };
        await dbReplaceRecord(record.id, merged);
        await deleteTextIndex(record.id);
        migrated++;
      } catch (error) {
        console.warn("No se pudo actualizar el documento", record.name, error);
      }
    }
  } finally {
    showLoader(false);
  }
  return migrated;
}

// ---- Almacenamiento persistente ----
// Sin este permiso el navegador puede borrar la biblioteca cuando necesita
// espacio (Safari, además, a los 7 días sin uso si la app no está instalada).
let persistRequested = false;
async function requestPersistentStorage() {
  if (persistRequested || !navigator.storage?.persist) return false;
  persistRequested = true;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
async function storageStatus() {
  let persisted = false,
    estimate = null;
  try {
    persisted = Boolean(await navigator.storage?.persisted?.());
  } catch {}
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {}
  return { supported: Boolean(navigator.storage?.persist), persisted, usage: estimate?.usage || 0, quota: estimate?.quota || 0 };
}
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

// ---- Copia de seguridad completa ----
// Un único archivo .paperbackup con la biblioteca (opcionalmente sin los PDFs),
// todas las notas, anotaciones, tarjetas y ajustes. Puede cifrarse con una
// contraseña. Restaurar combina: no borra nada de lo que ya tengas.
const DEVICE_ONLY_KEYS = /^paper\.(notes-window|assistant-window|ink-position|notes-minimized|footer-minimized|design-version|last-backup-at|split-width|sync-[\w-]+|__[\w-]+)$/;
async function exportFullBackup({ includeFiles = true, passphrase = "" } = {}) {
  if (!db) return toast("El almacenamiento local no está disponible");
  await kv.flush().catch(() => {});
  showLoader(true, "Preparando la copia…", includeFiles ? "Documentos, notas y ajustes" : "Notas y ajustes");
  try {
    const records = await dbAll();
    const files = [];
    const docs = records.map(({ blob, cover, ...meta }) => {
      const entry = { ...meta };
      if (includeFiles && blob) {
        entry.file = files.length;
        files.push(blob);
      }
      if (includeFiles && cover instanceof Blob) {
        entry.cover = files.length;
        files.push(cover);
      }
      return entry;
    });
    const values = {};
    for (const [k, entry] of Object.entries(kv.snapshot())) if (entry.v !== null && !DEVICE_ONLY_KEYS.test(k)) values[k] = entry.v;
    let blob = createBackupBlob(
      { schema: "paper-backup", version: 1, app: "Paper Reader", createdAt: new Date().toISOString(), includesFiles: includeFiles, docs, kv: values },
      files,
    );
    if (passphrase) {
      $("loaderText").textContent = "Cifrando la copia…";
      blob = await encryptBackupBlob(blob, passphrase);
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(`paper-reader-${includeFiles ? "copia" : "notas"}-${date}.paperbackup`, blob);
    kv.setItem("paper.last-backup-at", String(Date.now()));
    toast(`Copia creada · ${docs.length} documento${docs.length === 1 ? "" : "s"} · ${formatBytes(blob.size)}`, 3200);
  } catch (error) {
    console.error("No se pudo crear la copia", error);
    toast("No se pudo crear la copia de seguridad", 3200);
  } finally {
    showLoader(false);
  }
}
async function restoreFullBackup(file, passphrase = "") {
  const kind = await backupKind(file);
  if (kind === "unknown") throw new Error("Este archivo no es una copia de Paper Reader");
  if (kind === "encrypted" && !passphrase) {
    const error = new Error("Esta copia está cifrada: escribe su contraseña");
    error.code = "needs-passphrase";
    throw error;
  }
  showLoader(true, "Restaurando la copia…", file.name);
  try {
    const source = kind === "encrypted" ? await decryptBackupBlob(file, passphrase) : file;
    const { manifest, file: fileAt } = await readBackupBlob(source);
    let added = 0,
      missing = 0;
    for (const doc of manifest.docs || []) {
      const { file: fileIndex, cover: coverIndex, ...meta } = doc;
      if (!meta.id || (await dbGet(meta.id))) continue;
      const data = fileIndex !== undefined ? fileAt(fileIndex) : null;
      if (!data) {
        missing++;
        continue;
      }
      $("loaderText").textContent = meta.name || "Documento";
      await dbPut({
        ...meta,
        blob: new Blob([await data.arrayBuffer()], { type: meta.kind === "markdown" ? "text/markdown" : "application/pdf" }),
        cover: coverIndex !== undefined ? new Blob([await fileAt(coverIndex).arrayBuffer()], { type: "image/jpeg" }) : null,
      });
      added++;
    }
    // Notas y ajustes: se combinan con los actuales (unión de anotaciones,
    // tarjetas y marcadores; en lo demás se conserva lo que ya tienes).
    const local = kv.snapshot();
    const now = Date.now();
    const entries = [];
    for (const [k, value] of Object.entries(manifest.kv || {})) {
      if (DEVICE_ONLY_KEYS.test(k) || typeof value !== "string") continue;
      const current = local[k]?.v ?? null;
      const merged = current === null ? value : mergeValue(k, undefined, current, value, local[k]?.t || now, 0);
      if (merged !== current) entries.push([k, merged, now]);
    }
    const changed = kv.applyEntries(entries).length;
    await kv.flush();
    requestPersistentStorage();
    return { added, missing, changed, docs: (manifest.docs || []).length };
  } finally {
    showLoader(false);
  }
}
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- Ventana «Tus datos»: almacenamiento, copias y sincronización ----
let pendingRestoreFile = null;
async function renderDataPanel() {
  const body = $("dataBody");
  const [status, records] = await Promise.all([storageStatus(), dbAll().catch(() => [])]);
  const last = Number(kv.getItem("paper.last-backup-at")) || 0;
  const encrypt = $("backupEncrypt")?.checked || false;
  body.innerHTML = `<section class="data-card">
    <div class="data-card-head"><strong>Almacenamiento en este dispositivo</strong><span class="data-pill ${status.persisted ? "is-ok" : "is-warn"}">${status.persisted ? "Protegido" : "Sin proteger"}</span></div>
    <p>${records.length} documento${records.length === 1 ? "" : "s"} · ${formatBytes(status.usage)} en uso${status.quota ? ` de ${formatBytes(status.quota)} disponibles` : ""}${kv.mode === "local" ? " · <b>modo de reserva</b> (IndexedDB no disponible)" : ""}.</p>
    <p class="data-hint">${status.persisted ? "El navegador no borrará tu biblioteca para liberar espacio." : status.supported ? "El navegador podría borrar la biblioteca si se queda sin espacio. Protégela, instala la app o haz copias." : "Este navegador no permite proteger el almacenamiento: haz copias de seguridad de vez en cuando."}</p>
    ${!status.persisted && status.supported ? '<div class="data-actions"><button class="btn" data-data="persist">Proteger almacenamiento</button></div>' : ""}
  </section>
  <section class="data-card">
    <div class="data-card-head"><strong>Copia de seguridad</strong><span class="data-meta">${last ? `Última: ${relativeTime(last)}` : "Aún no has hecho ninguna"}</span></div>
    <p>Un solo archivo con todo: documentos, anotaciones, notas, tarjetas, progreso y ajustes.</p>
    <label class="data-check"><input type="checkbox" id="backupEncrypt"${encrypt ? " checked" : ""}> Cifrar con una contraseña</label>
    <input class="field data-pass" id="backupPassphrase" type="password" placeholder="Contraseña (mínimo 8 caracteres)" autocomplete="new-password"${encrypt ? "" : " hidden"}>
    <div class="data-actions"><button class="btn primary-action" data-data="backup-full">Copia completa</button><button class="btn" data-data="backup-notes">Solo notas y ajustes</button></div>
    <p class="data-hint">La copia «solo notas» ocupa muy poco: al volver a añadir los mismos PDFs, sus notas aparecen solas.</p>
  </section>
  <section class="data-card">
    <div class="data-card-head"><strong>Restaurar</strong></div>
    <p>Combina una copia con lo que ya tienes. No se borra nada: las anotaciones y tarjetas se suman y, si hay dos versiones de un ajuste, se conserva la tuya.</p>
    <input class="field data-pass" id="restorePassphrase" type="password" placeholder="Contraseña de la copia" autocomplete="current-password"${pendingRestoreFile ? "" : " hidden"}>
    <div class="data-actions"><label class="btn" for="restoreInput">Elegir copia…</label><input id="restoreInput" type="file" accept=".paperbackup,application/x-paper-backup,application/octet-stream" hidden>${pendingRestoreFile ? `<button class="btn primary-action" data-data="restore">Restaurar «${escapeHtml(pendingRestoreFile.name)}»</button>` : ""}</div>
  </section>
  ${syncSectionHtml()}`;
}
function openDataPanel() {
  $("dataPanel").hidden = false;
  renderDataPanel().then(() => $("dataPanel").querySelector(".study-card").focus());
}
function closeDataPanel() {
  $("dataPanel").hidden = true;
  pendingRestoreFile = null;
}
async function runRestore(file) {
  try {
    const result = await restoreFullBackup(file, $("restorePassphrase")?.value || "");
    pendingRestoreFile = null;
    const parts = [
      result.added ? `${result.added} documento${result.added === 1 ? "" : "s"} añadido${result.added === 1 ? "" : "s"}` : "",
      result.changed ? `${result.changed} dato${result.changed === 1 ? "" : "s"} combinado${result.changed === 1 ? "" : "s"}` : "",
      result.missing ? `${result.missing} sin PDF (sus notas aparecerán al añadirlo)` : "",
    ].filter(Boolean);
    toast(parts.length ? `Copia restaurada · ${parts.join(" · ")}` : "La copia no contenía nada nuevo", 4200);
    await renderLibrary();
    if (currentBook) await openStored(currentBook.id);
    else {
      const [latest] = (await dbAll()).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
      if (latest) await openStored(latest.id);
    }
  } catch (error) {
    if (error.code === "needs-passphrase") {
      pendingRestoreFile = file;
      toast(error.message, 3200);
    } else {
      console.error("No se pudo restaurar", error);
      toast(error.message || "No se pudo restaurar la copia", 3600);
      if (/contraseña/i.test(error.message)) pendingRestoreFile = file;
    }
  }
  if (!$("dataPanel").hidden) await renderDataPanel();
  if (pendingRestoreFile) $("restorePassphrase")?.focus();
}
function bindDataPanel() {
  setIcon("libraryDataBtn", "database");
  $("libraryDataBtn").onclick = openDataPanel;
  $("closeData").onclick = closeDataPanel;
  const panel = $("dataPanel");
  panel.addEventListener("pointerdown", (event) => {
    if (event.target === panel) closeDataPanel();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeDataPanel();
    }
  });
  panel.addEventListener("change", (event) => {
    if (event.target.id === "backupEncrypt") {
      $("backupPassphrase").hidden = !event.target.checked;
      if (event.target.checked) $("backupPassphrase").focus();
    } else if (event.target.id === "restoreInput") {
      const [file] = event.target.files || [];
      event.target.value = "";
      if (file) runRestore(file);
    }
  });
  panel.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-data]")?.dataset.data;
    if (!action) return;
    if (action === "persist") {
      persistRequested = false;
      const granted = await requestPersistentStorage();
      toast(granted ? "Almacenamiento protegido" : "El navegador no lo ha permitido. Instalar la app suele ayudar.", 3600);
      renderDataPanel();
    } else if (action === "backup-full" || action === "backup-notes") {
      const encrypt = $("backupEncrypt").checked;
      const passphrase = $("backupPassphrase").value;
      if (encrypt && passphrase.length < 8) {
        toast("La contraseña debe tener al menos 8 caracteres");
        $("backupPassphrase").focus();
        return;
      }
      await exportFullBackup({ includeFiles: action === "backup-full", passphrase: encrypt ? passphrase : "" });
      renderDataPanel();
    } else if (action === "restore" && pendingRestoreFile) {
      runRestore(pendingRestoreFile);
    } else {
      handleSyncAction(action);
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.id === "restorePassphrase" && pendingRestoreFile) runRestore(pendingRestoreFile);
    if (event.key === "Enter" && event.target.id === "syncPassphrase") handleSyncAction(syncState.needsPassphrase || pendingSyncRoot ? "sync-unlock" : "sync-setup");
  });
}

// ---- Sincronización entre dispositivos (ver sync.js) ----
const syncState = { configured: false, folderName: "", encrypted: false, needsPassphrase: false, permission: "", running: false, progress: "", lastSync: 0, lastSummary: null, error: "" };
let syncRoot = null,
  syncKey = null,
  pendingSyncRoot = null;
function metaGet(k) {
  if (!db) return Promise.resolve(null);
  return idbRequest(db.transaction("meta").objectStore("meta").get(k)).catch(() => null);
}
async function metaSet(k, value) {
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value, k);
  await idbDone(tx);
}
async function metaDelete(k) {
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").delete(k);
  await idbDone(tx);
}
async function loadSyncConfig() {
  if (!db || !folderSyncSupported()) return;
  const config = await metaGet("sync-config");
  syncRoot = config?.root || null;
  syncState.configured = Boolean(syncRoot);
  if (!syncRoot) return;
  syncState.folderName = syncRoot.name;
  syncState.encrypted = Boolean(config.encrypted);
  syncKey = config.encrypted ? await metaGet("sync-key") : null;
  syncState.needsPassphrase = syncState.encrypted && !syncKey;
  syncState.lastSync = Number(kv.getItem("paper.sync-last")) || 0;
  syncState.permission = await syncRoot.queryPermission({ mode: "readwrite" }).catch(() => "denied");
}
const syncAdapter = {
  listDocs: async () => (await dbAll()).filter((record) => record.blob).map(({ blob, cover, ...meta }) => ({ ...meta, size: meta.size || blob.size })),
  readDoc: async (id) => (await dbGet(id))?.blob || null,
  addDoc: async (meta, blob) => {
    if (!(await dbGet(meta.id))) await dbPut({ ...meta, blob });
  },
  deleteDoc: (id) => removeBook(id, { quiet: true }),
  kvSnapshot: () => kv.snapshot(),
  applyKv: async (entries) => {
    kv.applyEntries(entries);
    await kv.flush();
  },
  loadBase: () => metaGet("sync-base"),
  saveBase: (base) => metaSet("sync-base", base),
  confirmDeletions: async (docs) =>
    confirm(`La sincronización eliminaría ${docs.length} documento${docs.length === 1 ? "" : "s"} de este dispositivo porque se borraron en otro:\n\n${docs.slice(0, 8).map((doc) => `• ${libraryDisplayName(doc.name)}`).join("\n")}${docs.length > 8 ? "\n…" : ""}\n\n¿Eliminarlos? (Cancelar los conserva y los vuelve a subir.)`),
  filterKey: (k) => k.startsWith("paper.") && !DEVICE_ONLY_KEYS.test(k),
};
function syncSummaryText(summary) {
  if (!summary) return "";
  const parts = [
    summary.uploaded && `${summary.uploaded} subido${summary.uploaded === 1 ? "" : "s"}`,
    summary.downloaded && `${summary.downloaded} recibido${summary.downloaded === 1 ? "" : "s"}`,
    summary.deletedLocal + summary.deletedRemote && `${summary.deletedLocal + summary.deletedRemote} eliminado${summary.deletedLocal + summary.deletedRemote === 1 ? "" : "s"}`,
    summary.notesIn && `${summary.notesIn} cambio${summary.notesIn === 1 ? "" : "s"} de notas recibido${summary.notesIn === 1 ? "" : "s"}`,
    summary.missing && `${summary.missing} documento${summary.missing === 1 ? "" : "s"} aún llegando desde la nube`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Todo estaba al día";
}
function syncSectionHtml() {
  const head = (pill = "", pillClass = "") => `<div class="data-card-head"><strong>Sincronizar entre dispositivos</strong>${pill ? `<span class="data-pill ${pillClass}">${pill}</span>` : ""}</div>`;
  if (!folderSyncSupported())
    return `<section class="data-card">${head("No disponible aquí")}<p>La sincronización por carpeta necesita Chrome o Edge de escritorio. En este dispositivo puedes llevarte tus datos con «Copia completa» y «Restaurar».</p></section>`;
  const passField = `<input class="field data-pass" id="syncPassphrase" type="password" placeholder="Contraseña de sincronización" autocomplete="current-password">`;
  if (!syncState.configured && !pendingSyncRoot)
    return `<section class="data-card">${head()}<p>Elige una carpeta que tu nube ya sincronice (Dropbox, Google Drive, OneDrive, iCloud Drive…). Paper Reader guardará allí tu biblioteca y tus notas y las combinará con las de tus otros dispositivos. Nada pasa por servidores de Paper Reader.</p><label class="data-check"><input type="checkbox" id="syncEncrypt" checked> Cifrar de extremo a extremo (recomendado)</label>${passField.replace('autocomplete="current-password"', 'autocomplete="new-password"')}<div class="data-actions"><button class="btn primary-action" data-data="sync-setup">Elegir carpeta…</button></div><p class="data-hint">Usa la misma carpeta y la misma contraseña en todos tus dispositivos. Si la olvidas, no se puede recuperar.</p></section>`;
  if (syncState.needsPassphrase || pendingSyncRoot)
    return `<section class="data-card">${head("Bloqueada", "is-warn")}<p>La carpeta ${escapeHtml((pendingSyncRoot || syncRoot)?.name || "")} está cifrada. Escribe la contraseña de sincronización para usarla en este dispositivo.</p>${passField}<div class="data-actions"><button class="btn primary-action" data-data="sync-unlock">Desbloquear</button><button class="btn" data-data="sync-stop">Cancelar</button></div></section>`;
  const status = syncState.running
    ? escapeHtml(syncState.progress || "Sincronizando…")
    : syncState.error
      ? `<span class="data-error">${escapeHtml(syncState.error)}</span>`
      : syncState.lastSync
        ? `Última sincronización ${relativeTime(syncState.lastSync)}${syncState.lastSummary ? ` · ${escapeHtml(syncSummaryText(syncState.lastSummary))}` : ""}`
        : "Aún no se ha sincronizado";
  const permissionNote = syncState.permission !== "granted" ? '<p class="data-hint">El navegador necesita que vuelvas a autorizar el acceso a la carpeta: pulsa «Sincronizar ahora».</p>' : "";
  return `<section class="data-card">${head(syncState.running ? "Sincronizando…" : syncState.encrypted ? "Cifrada" : "Sin cifrar", syncState.running ? "" : syncState.encrypted ? "is-ok" : "")}<p>Carpeta <b>${escapeHtml(syncState.folderName)}</b> › Paper Reader. Se sincroniza al abrir la app y cada pocos minutos.</p><p class="data-status" id="syncStatus">${status}</p>${permissionNote}<div class="data-actions"><button class="btn primary-action" data-data="sync-now"${syncState.running ? " disabled" : ""}>Sincronizar ahora</button><button class="btn" data-data="sync-stop"${syncState.running ? " disabled" : ""}>Dejar de sincronizar</button></div></section>`;
}
function refreshDataPanel() {
  if (!$("dataPanel").hidden) renderDataPanel();
}
function refreshCurrentDocumentData() {
  if (!currentBook) return;
  renderAnnotations();
  renderAnnotationList();
  renderBookmarks();
  updateBookmarkButton();
  updateStudyLaunch();
  if (!$("notebookPanel").hidden && !$("notebookPanel").contains(document.activeElement)) renderNotebook();
}
async function runSync({ interactive = false } = {}) {
  if (syncState.running || !syncRoot || syncState.needsPassphrase) return null;
  let permission = await syncRoot.queryPermission({ mode: "readwrite" }).catch(() => "denied");
  if (permission !== "granted" && interactive) permission = await syncRoot.requestPermission({ mode: "readwrite" }).catch(() => "denied");
  syncState.permission = permission;
  if (permission !== "granted") {
    refreshDataPanel();
    if (interactive) toast("Sin permiso para usar la carpeta de sincronización", 3200);
    return null;
  }
  syncState.running = true;
  syncState.error = "";
  syncState.progress = "";
  refreshDataPanel();
  try {
    flushNotebook();
    await kv.flush();
    const dir = await syncRoot.getDirectoryHandle("Paper Reader", { create: true });
    const summary = await syncFolder({
      dir,
      key: syncKey,
      adapter: syncAdapter,
      onProgress: (text) => {
        syncState.progress = text;
        const status = $("syncStatus");
        if (status) status.textContent = text;
      },
    });
    syncState.lastSync = Date.now();
    syncState.lastSummary = summary;
    kv.setItem("paper.sync-last", String(syncState.lastSync));
    if (summary.downloaded || summary.deletedLocal || summary.uploaded) renderLibrary();
    if (summary.notesIn) refreshCurrentDocumentData();
    if (interactive) toast(`Sincronizado · ${syncSummaryText(summary)}`, 3600);
    return summary;
  } catch (error) {
    console.error("La sincronización falló", error);
    syncState.error = error?.name === "NotAllowedError" ? "El navegador ha retirado el permiso de la carpeta" : error.message || "La sincronización falló";
    if (interactive) toast(syncState.error, 4000);
    return null;
  } finally {
    syncState.running = false;
    refreshDataPanel();
  }
}
async function handleSyncAction(action) {
  const passphrase = $("syncPassphrase")?.value || "";
  if (action === "sync-setup") {
    const encrypt = $("syncEncrypt")?.checked;
    if (encrypt && passphrase.length < 8) {
      toast("Escribe una contraseña de al menos 8 caracteres");
      $("syncPassphrase")?.focus();
      return;
    }
    let root;
    try {
      root = await window.showDirectoryPicker({ id: "paper-sync", mode: "readwrite" });
    } catch {
      return;
    }
    await connectSyncFolder(root, encrypt ? passphrase : "", { wantedEncryption: encrypt });
  } else if (action === "sync-unlock") {
    const root = pendingSyncRoot || syncRoot;
    if (!root) return;
    if (!passphrase) return $("syncPassphrase")?.focus();
    await connectSyncFolder(root, passphrase);
  } else if (action === "sync-now") {
    await runSync({ interactive: true });
  } else if (action === "sync-stop") {
    if (syncState.configured && !confirm("¿Dejar de sincronizar este dispositivo? Tus datos locales y la carpeta se quedan como están.")) return;
    pendingSyncRoot = null;
    await Promise.all(["sync-config", "sync-key", "sync-base"].map((k) => metaDelete(k).catch(() => {})));
    Object.assign(syncState, { configured: false, folderName: "", encrypted: false, needsPassphrase: false, lastSummary: null, error: "" });
    syncRoot = null;
    syncKey = null;
    refreshDataPanel();
  }
}
async function connectSyncFolder(root, passphrase, { wantedEncryption = false } = {}) {
  try {
    const permission = root.requestPermission ? await root.requestPermission({ mode: "readwrite" }).catch(() => "denied") : "granted";
    if (permission !== "granted") throw new Error("Sin permiso para escribir en esa carpeta");
    const opened = await openSyncFolder(root, passphrase);
    const previous = await metaGet("sync-config");
    await metaSet("sync-config", { root, encrypted: opened.encrypted });
    if (opened.key) await metaSet("sync-key", opened.key);
    else await metaDelete("sync-key");
    // Otra carpeta = otro historial: sin base, la primera vez solo se suma.
    if (!previous?.root || !(await previous.root.isSameEntry?.(root))) await metaDelete("sync-base");
    pendingSyncRoot = null;
    await loadSyncConfig();
    if (wantedEncryption && !opened.encrypted && !opened.created) toast("Esa carpeta ya se usaba sin cifrar y se mantiene así", 4000);
    await runSync({ interactive: true });
  } catch (error) {
    if (error.code === "needs-passphrase" || error.code === "bad-passphrase") {
      pendingSyncRoot = root;
      toast(error.message, 3600);
    } else {
      console.error("No se pudo preparar la carpeta", error);
      toast(error.message || "No se pudo usar esa carpeta", 3600);
    }
    refreshDataPanel();
    if (pendingSyncRoot) requestAnimationFrame(() => $("syncPassphrase")?.focus());
  }
}
function startBackgroundSync() {
  loadSyncConfig()
    .then(() => {
      if (syncState.configured && syncState.permission === "granted") runSync();
    })
    .catch((error) => console.warn("No se pudo leer la configuración de sincronización", error));
  setInterval(() => {
    if (document.visibilityState === "visible" && syncState.configured && syncState.permission === "granted") runSync();
  }, 5 * 60_000);
}

// ---- Biblioteca -------------------------------------------------------------
let libraryFilter = kv.getItem("paper.library-filter") || "all";
// Portadas: una URL por documento que se reutiliza entre redibujados (antes
// se creaban nuevas en cada uno y la cuadrícula entera se sustituía).
const libraryCoverCache = new Map();
function libraryCoverUrl(book) {
  if (!(book.cover instanceof Blob)) return "";
  const cached = libraryCoverCache.get(book.id);
  if (cached && cached.size === book.cover.size && cached.type === book.cover.type) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(book.cover);
  libraryCoverCache.set(book.id, { url, size: book.cover.size, type: book.cover.type });
  return url;
}
// Solo se toca el DOM si el contenido cambia: un redibujado entre el toque y
// el final del toque hacía que el clic se perdiera o cayera en otra tarjeta.
const renderedHtml = new WeakMap();
function setHtml(element, html) {
  if (renderedHtml.get(element) === html) return;
  renderedHtml.set(element, html);
  element.innerHTML = html;
}
let libraryCoverQueue = Promise.resolve();
const libraryCoverPending = new Set();
function libraryDisplayName(name) {
  return String(name || "Documento").replace(/\.(pdf|md|markdown)$/i, "").replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
function relativeTime(timestamp) {
  if (!timestamp) return "";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "ahora mismo";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return new Date(timestamp).toLocaleDateString("es", { day: "numeric", month: "short", year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
function libraryStatus(book, stats) {
  // Estar en la última página solo cuenta como terminado si hay algo más que
  // leer antes o si se ha leído un rato (un Markdown o un PDF de una página
  // salían «Terminados» nada más abrirlos).
  if (stats.progress >= 100 && (Number(book.pages) > 1 || Number(stats.totalMs || 0) >= 60_000)) return "done";
  if (stats.page <= 1 && Number(stats.totalMs || 0) < 5000) return "new";
  return "reading";
}
// Portada real: la primera página del PDF, guardada con el documento.
async function renderPdfCover(doc) {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 360 / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}
async function ensureBookCover(rec, doc = null) {
  if (!rec || rec.kind === "markdown" || rec.cover || libraryCoverPending.has(rec.id)) return;
  libraryCoverPending.add(rec.id);
  libraryCoverQueue = libraryCoverQueue.then(async () => {
    let own = null;
    try {
      const source = doc || (own = await pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise);
      const cover = await renderPdfCover(source);
      if (!cover) return;
      const fresh = (await dbGet(rec.id)) || rec;
      fresh.cover = cover;
      if (!fresh.pages) fresh.pages = source.numPages;
      await dbPut(fresh);
      if (currentBook?.id === rec.id) currentBook.cover = cover;
      const url = libraryCoverUrl({ id: rec.id, cover });
      document.querySelectorAll(`[data-cover-for="${CSS.escape(encodeURIComponent(rec.id))}"]`).forEach((holder) => {
        holder.classList.add("has-image");
        holder.querySelector("img")?.remove();
        holder.insertAdjacentHTML("afterbegin", `<img src="${url}" alt="" loading="lazy">`);
      });
    } catch (error) {
      console.warn("No se pudo generar la portada", error);
    } finally {
      own?.destroy?.();
      libraryCoverPending.delete(rec.id);
    }
  });
  return libraryCoverQueue;
}
function libraryCoverHtml(book, url, large = false) {
  const isMarkdown = book.kind === "markdown";
  const name = libraryDisplayName(book.name);
  return `<span class="lib-cover${isMarkdown ? " is-markdown" : ""}${url ? " has-image" : ""}${large ? " is-large" : ""}" data-cover-for="${encodeURIComponent(book.id)}">${
    url ? `<img src="${url}" alt="" loading="lazy">` : ""
  }<span class="lib-cover-fallback"><b>${escapeHtml(name.slice(0, 80))}</b></span><span class="lib-badge">${isMarkdown ? "MD" : "PDF"}</span></span>`;
}
async function renderLibrary() {
  flushReadingSession(false);
  const books = await dbAll();
  const present = new Set(books.map((book) => book.id));
  for (const [id, entry] of libraryCoverCache) {
    if (!present.has(id)) {
      URL.revokeObjectURL(entry.url);
      libraryCoverCache.delete(id);
    }
  }
  const coverUrl = libraryCoverUrl;
  const query = ($("librarySearch")?.value || "").trim().toLocaleLowerCase();
  const sort = $("librarySort")?.value || kv.getItem("paper.library-sort") || "recent";
  const view = kv.getItem("paper.library-view") || "grid";
  const estimates = new Map(books.map((book) => [book.id, readingEstimate(book)]));
  const status = new Map(books.map((book) => [book.id, libraryStatus(book, estimates.get(book.id))]));
  const counts = { all: books.length, reading: 0, new: 0, done: 0, markdown: 0 };
  books.forEach((book) => {
    counts[status.get(book.id)]++;
    if (book.kind === "markdown") counts.markdown++;
  });
  if (libraryFilter !== "all" && !counts[libraryFilter]) libraryFilter = "all";
  const matchesFilter = (book) => libraryFilter === "all" || (libraryFilter === "markdown" ? book.kind === "markdown" : status.get(book.id) === libraryFilter);
  const visibleBooks = books
    .filter((book) => (!query || book.name.toLocaleLowerCase().includes(query) || libraryDisplayName(book.name).toLocaleLowerCase().includes(query)) && matchesFilter(book))
    .sort((a, b) => {
      if (sort === "name") return libraryDisplayName(a.name).localeCompare(libraryDisplayName(b.name), "es", { sensitivity: "base", numeric: true });
      if (sort === "progress") return estimates.get(b.id).progress - estimates.get(a.id).progress;
      if (sort === "remaining") return estimates.get(a.id).remainingMs - estimates.get(b.id).remainingMs;
      if (sort === "added") return (b.addedAt || b.openedAt || 0) - (a.addedAt || a.openedAt || 0);
      return (b.openedAt || 0) - (a.openedAt || 0);
    });
  const totalMs = [...estimates.values()].reduce((sum, stats) => sum + Number(stats.totalMs || 0), 0);
  const remainingMs = books.reduce((sum, book) => sum + (status.get(book.id) === "done" ? 0 : Number(estimates.get(book.id).remainingMs || 0)), 0);
  $("librarySummary").textContent = books.length
    ? [`${books.length} documento${books.length === 1 ? "" : "s"}`, totalMs >= 60000 ? `${formatReadingDuration(totalMs, true)} leídos` : "", remainingMs >= 60000 ? `≈ ${formatReadingDuration(remainingMs, true)} por leer` : ""].filter(Boolean).join(" · ")
    : "Tus PDFs, privados y siempre a mano";
  // Continuar leyendo: el documento en curso más reciente.
  const resume = !query && libraryFilter === "all" ? [...books].filter((book) => status.get(book.id) === "reading").sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0] : null;
  const continueBox = $("libraryContinue");
  if (resume) {
    const stats = estimates.get(resume.id);
    continueBox.hidden = false;
    setHtml(continueBox, `<button class="lib-hero" data-id="${encodeURIComponent(resume.id)}">${libraryCoverHtml(resume, coverUrl(resume), true)}<span class="lib-hero-copy"><small>${currentBook?.id === resume.id ? "Abierto ahora" : `Continuar leyendo · ${relativeTime(resume.openedAt)}`}</small><strong title="${escapeHtml(resume.name)}">${escapeHtml(libraryDisplayName(resume.name))}</strong><span>Página ${stats.page} de ${resume.pages || "—"} · ${stats.progress}% · ≈ ${formatReadingDuration(stats.remainingMs, true)} para terminar</span><i class="lib-progress"><b style="width:${stats.progress}%"></b></i><em class="lib-hero-cta">${currentBook?.id === resume.id ? "Volver a la lectura" : "Continuar"} ${iconSvg("chevronRight")}</em></span></button>`);
  } else {
    continueBox.hidden = true;
    setHtml(continueBox, "");
  }
  const filters = [
    ["all", "Todos"],
    ["reading", "Leyendo"],
    ["new", "Sin empezar"],
    ["done", "Terminados"],
    ...(counts.markdown ? [["markdown", "Markdown"]] : []),
  ];
  setHtml($("libraryFilters"), books.length
    ? filters.map(([id, label]) => `<button type="button" role="radio" data-library-filter="${id}" aria-checked="${libraryFilter === id}" ${id !== "all" && !counts[id] ? "disabled" : ""}>${label}<span>${counts[id]}</span></button>`).join("")
    : "");
  document.querySelectorAll("[data-library-view]").forEach((button) => button.setAttribute("aria-checked", String(button.dataset.libraryView === view)));
  $("librarySort").value = sort;
  $("libraryPanel").classList.toggle("is-empty", !books.length);
  const grid = $("library");
  grid.dataset.view = view;
  setHtml(grid, visibleBooks.length
    ? visibleBooks
        .map((book) => {
          const stats = estimates.get(book.id);
          const state = status.get(book.id);
          const isCurrent = currentBook?.id === book.id;
          const pageInfo = book.kind === "markdown" ? "Markdown" : book.pages ? `p. ${stats.page} de ${book.pages}` : "PDF";
          const detail = state === "done" ? "Terminado" : state === "new" ? `Sin empezar · ≈ ${formatReadingDuration(stats.remainingMs, true)}` : `≈ ${formatReadingDuration(stats.remainingMs, true)} restantes`;
          return `<article class="lib-book${isCurrent ? " is-current" : ""} is-${state}"><button class="lib-open" data-id="${encodeURIComponent(book.id)}" title="${escapeHtml(book.name)}">${libraryCoverHtml(book, coverUrl(book))}<span class="lib-info"><strong class="lib-name">${escapeHtml(libraryDisplayName(book.name))}</strong><span class="lib-meta">${pageInfo}${state === "reading" ? ` · ${stats.progress}%` : ""}</span><span class="lib-detail">${isCurrent ? "Abierto ahora" : detail}</span><span class="lib-when">${relativeTime(book.openedAt)}</span><i class="lib-progress"><b style="width:${stats.progress}%"></b></i></span></button><button class="lib-remove" data-remove-book="${encodeURIComponent(book.id)}" aria-label="Eliminar ${escapeHtml(book.name)}" title="Eliminar de la biblioteca">${iconSvg("trash")}</button></article>`;
        })
        .join("")
    : books.length
      ? `<div class="lib-empty"><strong>Nada por aquí</strong><p>${query ? `Ningún documento coincide con «${escapeHtml(query)}».` : "No hay documentos con este filtro."}</p></div>`
      : `<div class="lib-empty is-first"><span>${iconSvg("library")}</span><strong>Tu biblioteca está vacía</strong><p>Añade un PDF o un Markdown para empezar. Se guardan solo en este dispositivo.</p><label class="lib-add" for="fileInput">${iconSvg("plus")}<span>Añadir documento</span></label></div>`);
  books.filter((book) => book.kind !== "markdown" && !book.cover).forEach((book) => ensureBookCover(book));
}
function openLibrary() {
  flushReadingSession(true);
  $("libraryPanel").hidden = false;
  document.body.classList.add("library-open");
  renderLibrary();
  requestAnimationFrame(() => (window.innerWidth > 700 ? $("librarySearch") : $("closeLibrary")).focus({ preventScroll: true }));
}
function closeLibrary() {
  $("libraryPanel").hidden = true;
  document.body.classList.remove("library-open");
  markReadingActivity();
}
async function addFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return;
  for (const [index, file] of list.entries()) await addFile(file, index === list.length - 1);
  if (list.length > 1) toast(`${list.length} documentos añadidos`);
}
function bindLibrary() {
  setIcon("closeLibrary", "close");
  $("libraryAddIcon").innerHTML = iconSvg("plus");
  $("librarySearchIcon").innerHTML = iconSvg("search");
  document.querySelector('[data-library-view="grid"]').innerHTML = iconSvg("grid");
  document.querySelector('[data-library-view="list"]').innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>';
  const sort = kv.getItem("paper.library-sort");
  if (sort) $("librarySort").value = sort;
  $("homeBtn").onclick = openLibrary;
  $("emptyLibraryBtn").onclick = openLibrary;
  $("closeLibrary").onclick = closeLibrary;
  $("librarySearch").addEventListener("input", renderLibrary);
  $("librarySort").addEventListener("change", () => {
    kv.setItem("paper.library-sort", $("librarySort").value);
    renderLibrary();
  });
  const panel = $("libraryPanel");
  panel.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-book]");
    if (remove) return deleteBook(decodeURIComponent(remove.dataset.removeBook));
    const open = event.target.closest("[data-id]");
    if (open) {
      const id = decodeURIComponent(open.dataset.id);
      closeLibrary();
      openDocument(id);
      return;
    }
    const filter = event.target.closest("[data-library-filter]");
    if (filter) {
      libraryFilter = filter.dataset.libraryFilter;
      kv.setItem("paper.library-filter", libraryFilter);
      return renderLibrary();
    }
    const view = event.target.closest("[data-library-view]");
    if (view) {
      kv.setItem("paper.library-view", view.dataset.libraryView);
      return renderLibrary();
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !currentBook) return;
    if (event.target === $("librarySearch") && $("librarySearch").value) return;
    event.stopPropagation();
    closeLibrary();
  });
  // Arrastrar archivos a cualquier parte de la aplicación.
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    if (panel.hidden) openLibrary();
    $("libraryDrop").hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("libraryDrop").hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $("libraryDrop").hidden = true;
    addFiles(event.dataTransfer.files);
  });
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function addFile(file, open = true) {
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
    const buffer = await file.arrayBuffer();
    const id = await documentIdFor(buffer, file);
    const existing = await dbGet(id);
    const record = {
      ...existing,
      id,
      name: file.name,
      kind: isMarkdown ? "markdown" : "pdf",
      blob: new Blob([buffer], { type: isMarkdown ? "text/markdown" : "application/pdf" }),
      size: buffer.byteLength,
      addedAt: existing?.addedAt || Date.now(),
      openedAt: Date.now(),
      pages: isMarkdown ? 1 : existing?.pages || null,
    };
    await dbPut(record);
    if (existing) toast(existing.name === file.name ? "Ya estaba en tu biblioteca: se conservan sus notas" : `Es el mismo documento que «${libraryDisplayName(existing.name)}»: se conservan sus notas`, 3200);
    requestPersistentStorage();
    if (open) await openStored(id);
    else {
      ensureBookCover(record);
      if (!$("libraryPanel").hidden) renderLibrary();
    }
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
async function openMarkdownStored(rec, superseded = () => false) {
  flushReadingSession(true);
  flushNotebook();
  setStickyPlacement(false);
  if (activeStickyId) closeStickyEditor();
  const text = await rec.blob.text();
  rec.openedAt = Date.now();
  rec.pages = 1;
  if (!superseded()) await dbPut(rec);
  if (superseded()) return;
  markdownContent = text;
  resetRenderEngine();
  teardownContinuous();
  viewMode = "single";
  $("continuousView").hidden = true;
  $("facingWrap").hidden = true;
  $("viewer").classList.remove("double-mode");
  pdfDoc = null;
  currentBook = rec;
  assistantLoadDocument();
  boardLoadDocument();
  resetAnnotationHistory();
  migrateLegacyPageNotes();
  currentPage = 1;
  reflowMode = true;
  document.body.classList.add("reflow-mode");
  $("markerModeBtn").disabled = true;
  $("eraserModeBtn").disabled = true;
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
  $("toolbarPage").value = 1;
  $("toolbarPage").disabled = true;
  $("toolbarPageCount").textContent = "/ —";
  $("toolbarPrev").disabled = true;
  $("toolbarNext").disabled = true;
  $("pageScrubber").disabled = true;
  $("progressBar").style.width = "0";
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
// Si se abre otro documento mientras este aún se prepara, la apertura antigua
// se abandona en vez de pintar sus marcadores o su índice sobre el nuevo.
// `requestedDocId` es siempre el último documento pedido (aunque aún cargue).
let openStoredToken = 0;
let requestedDocId = "";
// Abrir desde la biblioteca, la paleta o un resultado: pulsar el documento
// que ya está abierto no hace nada, salvo que haya otro cargándose (antes se
// ignoraba el toque y acababa abriéndose el otro).
function openDocument(id) {
  if (id && id === requestedDocId && currentBook?.id === id) return Promise.resolve();
  return openStored(id);
}
async function openStored(id) {
  const openToken = ++openStoredToken;
  const superseded = () => openToken !== openStoredToken;
  requestedDocId = id;
  showLoader(true);
  try {
    if (currentBook?.id !== id) flushReadingSession(true);
    if (ttsActive && currentBook?.id !== id) stopReadAloud();
    flushNotebook();
    setStickyPlacement(false);
    if (activeStickyId) closeStickyEditor();
    if (currentBook?.id !== id) setAutoScroll(false);
    const rec = await dbGet(id);
    if (superseded()) return;
    if (!rec) throw new Error("Documento no encontrado");
    if (rec.kind === "markdown") {
      await openMarkdownStored(rec, superseded);
      return;
    }
    markdownContent = "";
    reflowMode = kv.getItem("paper.reading-mode") === "reflow";
    document.body.classList.toggle("reflow-mode", reflowMode);
    $("markerModeBtn").disabled = reflowMode;
    $("eraserModeBtn").disabled = reflowMode;
    $("reflowControls").hidden = !reflowMode;
    document.querySelectorAll("[data-reading-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.readingMode === (reflowMode ? "reflow" : "pdf")),
    );
    resetRenderEngine();
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    const loadedDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    rec.pages = loadedDoc.numPages;
    rec.openedAt = Date.now();
    if (!superseded()) await dbPut(rec);
    if (superseded()) {
      loadedDoc.destroy?.();
      return;
    }
    // A partir de aquí no hay esperas hasta el primer render: el documento
    // nuevo y su estado se asignan juntos.
    pdfDoc = loadedDoc;
    currentBook = rec;
    if (!rec.cover) ensureBookCover(rec, pdfDoc);
    loadCurrentDocText(rec, pdfDoc);
    assistantLoadDocument();
    boardLoadDocument();
    resetAnnotationHistory();
    migrateLegacyPageNotes();
    teardownReflowDocument();
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
      Number(kv.getItem(key(id, "page")) || 1),
      pdfDoc.numPages,
    );
    const storedScale = Number(kv.getItem(key(id, "scale")));
    scale = storedScale > 0 ? storedScale : 1.25;
    rotation = Number(kv.getItem(key(id, "rotation")) || 0) % 360;
    $("emptyState").hidden = true;
    $("canvasWrap").hidden = false;
    document.body.classList.add("has-doc");
    // El zoom se decide por modo: los documentos sin modo guardado (o con un
    // zoom manual sin escala) abren en «Automático», que siempre cabe bien.
    zoomMode = kv.getItem(key(id, "zoom-mode")) || "auto";
    if (zoomMode === "custom" && !(storedScale > 0)) zoomMode = "auto";
    if (zoomMode !== "custom") scale = await computeZoomForMode(zoomMode);
    if (superseded()) return;
    $("docTitle").textContent = rec.name;
    $("docMeta").textContent =
      `${pdfDoc.numPages} páginas · guardado localmente`;
    await renderPage(currentPage);
    if (superseded()) return;
    const storedViewMode = kv.getItem("paper.view-mode") || "single";
    if (!reflowMode && storedViewMode !== "single") await setViewMode(storedViewMode, { silent: true });
    if (superseded()) return;
    else document.querySelectorAll("[data-view-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.viewMode === viewMode),
    );
    renderBookmarks();
    renderAnnotationList();
    if (!$("sidebarRefsPanel").hidden) renderReferencesPanel();
    await renderOutline();
    renderLibrary();
    if (!$("notebookPanel").hidden) renderNotebook();
    if (kv.getItem("paper.ruler") === "1") setReadingRuler(true, true);
    updateStudyLaunch();
    document.body.classList.remove("sidebar-open");
    markReadingActivity();
  } catch (e) {
    console.error(e);
    if (!superseded()) {
      requestedDocId = currentBook?.id || "";
      toast("No se pudo abrir el PDF");
    }
  } finally {
    if (!superseded()) showLoader(false);
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
  if (reflowMode && currentBook && reflowBuiltFor === currentBook.id) {
    return scrollToReflowPage(pageNumber, { smooth: false }).then(() => true);
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
  updateFooterMini();
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
  syncAssistantPage();
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
// Al vaciar o redimensionar la vista, el navegador mueve el scroll (a 0 al
// vaciarla): esos saltos no deben tomarse como «el lector ha ido a la página 1».
let continuousSyncHold = 0;
function holdContinuousSync(ms = 400) {
  continuousSyncHold = performance.now() + ms;
}
async function buildContinuousView(targetPage = currentPage) {
  const container = $("continuousView");
  if (!container || !pdfDoc) return;
  holdContinuousSync();
  teardownContinuous();
  const first = await getCachedPage(targetPage);
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
  holdContinuousSync();
  markContinuousCurrent();
}
// Cambio de zoom, giro o tamaño de ventana: se redimensionan las páginas sin
// reconstruir la vista y se conserva el punto exacto de lectura.
async function rescaleContinuousView() {
  const container = $("continuousView");
  if (!container || !pdfDoc) return;
  if (container.children.length !== pdfDoc.numPages) {
    const target = currentPage;
    await buildContinuousView(target);
    scrollToContinuousPage(target, { smooth: false });
    return;
  }
  const viewer = $("viewer");
  const target = currentPage;
  const before = container.children[target - 1];
  const ratio = before.offsetHeight ? (viewer.scrollTop - before.offsetTop) / before.offsetHeight : 0;
  const horizontal = viewer.scrollWidth > viewer.clientWidth ? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth : 0.5;
  const page = await getCachedPage(target);
  if (viewMode !== "continuous") return;
  const viewport = page.getViewport({ scale, rotation });
  holdContinuousSync();
  for (const pageNumber of continuousRendered) {
    const slot = container.children[pageNumber - 1];
    if (slot) clearContinuousSlot(slot);
  }
  continuousRendered = new Set();
  for (const slot of container.children) {
    slot.style.width = `${viewport.width}px`;
    slot.style.height = `${viewport.height}px`;
  }
  const after = container.children[target - 1];
  viewer.scrollTop = after.offsetTop + ratio * after.offsetHeight;
  viewer.scrollLeft = Math.max(0, horizontal * viewer.scrollWidth - viewer.clientWidth / 2);
  // Volver a observar provoca el aviso inicial y se dibujan las visibles.
  continuousObserver?.disconnect();
  container.querySelectorAll(".cont-page").forEach((slot) => continuousObserver?.observe(slot));
  holdContinuousSync();
  syncCurrentFromScroll(target);
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
    if (captureAreas().some((area) => area.page === pageNumber)) renderAreaMarks();
    if (board.data?.items.some((item) => item.source?.page === pageNumber)) renderBoardLinks();
    // Si la página salió de la vista mientras se dibujaba, se libera ya: si no,
    // un desplazamiento rápido dejaba cientos de lienzos ocupando memoria.
    if (!continuousRendered.has(pageNumber)) clearContinuousSlot(slot);
    trimContinuousRenders();
  } catch {
    continuousRendered.delete(pageNumber);
  }
}
// Límite de páginas dibujadas a la vez (proporcional a las que caben en
// pantalla): se liberan las más alejadas de la página actual.
function trimContinuousRenders() {
  const container = $("continuousView");
  const sample = container?.children[currentPage - 1];
  if (!sample) return;
  const perScreen = Math.ceil($("viewer").clientHeight / Math.max(40, sample.offsetHeight));
  const limit = Math.max(14, perScreen * 3 + 4);
  if (continuousRendered.size <= limit) return;
  const farthest = [...continuousRendered].sort((a, b) => Math.abs(b - currentPage) - Math.abs(a - currentPage));
  for (const page of farthest.slice(0, continuousRendered.size - limit)) {
    const slot = container.children[page - 1];
    if (slot) unloadContinuousSlot(slot);
  }
}
function unloadContinuousSlot(slot) {
  const pageNumber = Number(slot.dataset.page);
  if (!continuousRendered.has(pageNumber)) return;
  continuousRendered.delete(pageNumber);
  clearContinuousSlot(slot);
}
function clearContinuousSlot(slot) {
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
  const container = $("continuousView");
  if (!container) return;
  container.querySelector(".cont-page.is-current")?.classList.remove("is-current");
  container.children[currentPage - 1]?.classList.add("is-current");
}
function scrollToContinuousPage(pageNumber, options = {}) {
  const container = $("continuousView");
  if (!container) return;
  const target = Math.max(1, Math.min(pdfDoc.numPages, pageNumber));
  const slot = container.children[target - 1];
  syncCurrentFromScroll(target);
  if (slot && options.scroll !== false) {
    const smooth = options.smooth !== false;
    // Durante un salto suave no se va marcando cada página por la que pasa.
    holdContinuousSync(smooth ? 900 : 250);
    $("viewer").scrollTo({ top: slot.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
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
  if (currentBook) kv.setItem(key(currentBook.id, "page"), String(currentPage));
  updatePageChrome();
  updateThumbSelection();
  updateOutlineSelection();
  markContinuousCurrent();
  if (presentationMode) updatePresentationCount();
}
// La página actual es la que ocupa la franja de lectura (un tercio desde
// arriba), el mismo criterio con el que se salta a una página.
function continuousPageAtReadingLine() {
  const viewer = $("viewer");
  const slots = $("continuousView").children;
  if (!slots.length) return 0;
  const probe = viewer.scrollTop + Math.min(viewer.clientHeight * 0.33, 260);
  // Las páginas están en orden vertical: búsqueda binaria en vez de medir
  // las mil páginas de un libro largo en cada fotograma.
  let lo = 0,
    hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].offsetTop + slots[mid].offsetHeight < probe) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}
let continuousRetryTimer = 0;
function onContinuousScroll() {
  if (viewMode !== "continuous" || continuousScrollFrame) return;
  continuousScrollFrame = requestAnimationFrame(() => {
    continuousScrollFrame = 0;
    if (performance.now() < continuousSyncHold) {
      // Se vuelve a mirar al terminar la pausa por si el lector siguió moviéndose.
      clearTimeout(continuousRetryTimer);
      continuousRetryTimer = setTimeout(onContinuousScroll, continuousSyncHold - performance.now() + 30);
      return;
    }
    const page = continuousPageAtReadingLine();
    if (page && page !== currentPage) syncCurrentFromScroll(page);
  });
}

// ---- Selector de diseño de página ----
async function setViewMode(mode, options = {}) {
  if (!["single", "double", "continuous"].includes(mode)) mode = "single";
  if (reflowMode && mode !== "single") await setReadingMode("pdf");
  const previous = viewMode;
  viewMode = mode;
  kv.setItem("paper.view-mode", mode);
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
    const target = currentPage;
    await buildContinuousView(target);
    scrollToContinuousPage(target, { smooth: false });
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
    rescaleContinuousView();
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
    { icon: "✦", title: "Asistente IA: abrir o cerrar", keys: "asistente ia chat pregunta preguntar documento", shortcut: ["I"], when: hasDoc, run: () => toggleAssistant() },
    { icon: "✎", title: "Pizarra: escribir a mano junto al documento", keys: "pizarra tablero apuntes mano lapiz dibujar ejercicios whiteboard", shortcut: ["W"], when: hasDoc, run: toggleBoard },
    { icon: "✂", title: "Recortar una zona para la IA (fórmula, tabla, figura…)", keys: "recortar area zona formula ecuacion captura imagen simbolos", shortcut: ["X"], when: hasPdf, run: () => openCapture() },
    { icon: "✦", title: "Resumir esta página con IA", keys: "resumen sintesis puntos clave", when: hasDoc, run: () => runAssistantAction("summary", { kind: "page" }) },
    { icon: "✦", title: "Resumir todo el documento con IA", keys: "resumen general sintesis documento completo", when: hasDoc, run: () => runAssistantAction("summary", { kind: "document" }) },
    { icon: "✦", title: "Explicar la selección con IA", keys: "explicar simplificar entender", when: hasDoc, run: () => runAssistantAction("explain", captureReaderSelection() ? { kind: "selection" } : { kind: "page" }) },
    { icon: "✦", title: "Preguntar al documento (IA local)", keys: "asistente ia chat pregunta", when: hasDoc, run: () => openAssistant({ context: { kind: "document" }, focus: true }) },
    { icon: "☀", title: "Tema claro", keys: "apariencia color", run: () => setTheme("light") },
    { icon: "☾", title: "Tema oscuro", keys: "apariencia noche", run: () => setTheme("dark") },
    { icon: "◐", title: "Tema sepia", keys: "apariencia papel", run: () => setTheme("sepia") },
    { icon: "↗", title: "Exportar anotaciones a Markdown", keys: "descargar notas md", when: hasDoc, run: exportMarkdown },
    { icon: "⇩", title: "Guardar PDF con las anotaciones dentro", keys: "exportar descargar pdf anotado acrobat zotero goodnotes compartir", when: hasPdf, run: exportAnnotatedPdf },
    { icon: "↓", title: "Exportar copia de las anotaciones (JSON)", keys: "descargar backup", when: hasDoc, run: exportAnnotations },
    { icon: "◫", title: splitOpen() ? "Cerrar la vista dividida" : "Vista dividida (dos documentos a la vez)", keys: "split dividir comparar dos paneles lado", shortcut: ["D"], when: hasPdf, run: toggleSplitView },
    { icon: "❝", title: "Referencias y cita del documento", keys: "bibliografia bibtex zotero doi citar referencias ris", when: hasPdf, run: () => { if (isDrawerLayout()) document.body.classList.add("sidebar-open"); else if (document.body.classList.contains("sidebar-collapsed")) toggleSidebar(); setSidebarPanel("refs"); } },
    { icon: "⛁", title: "Copia de seguridad y sincronización", keys: "backup exportar restaurar importar sincronizar nube dropbox drive datos", run: openDataPanel },
    { icon: "⛁", title: "Sincronizar ahora", keys: "sync nube dispositivos", when: syncState.configured, run: () => runSync({ interactive: true }) },
    { icon: "⌨", title: "Ver atajos de teclado", keys: "ayuda teclas", shortcut: ["?"], run: openShortcuts },
  ];
  return actions.filter((action) => action.when === undefined || action.when);
}
// La paleta usa el índice de texto del documento (guardado o en construcción).
function ensurePaletteTextIndex() {
  if (!pdfDoc || !currentBook || docText.id !== currentBook.id) return null;
  buildDocText(docText);
  paletteTextIndex = docText;
  return docText;
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
      run: () => openDocument(record.id),
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
  ["Lectura", [["Regla de lectura", ["G"]], ["Mover la regla", ["↑", "↓"]], ["Desplazamiento automático", ["A"]], ["Pausar / velocidad (auto-scroll)", ["Espacio", "[", "]"]], ["Modo enfoque", ["F"]], ["Presentación", ["P"]], ["Vista dividida", ["D"]], ["Modo lectura adaptable", ["L"]], ["Acercar / alejar", ["+", "−"]], ["Girar página", ["R"]], ["Marcar página", ["B"]]]],
  ["Notas y anotaciones", [["Nota en un punto de la página", ["N"]], ["Ventana de notas", ["C"]], ["Pizarra a mano junto al documento", ["W"]], ["Editar anotaciones", ["S"]], ["Deshacer", ["Ctrl", "Z"]], ["Rehacer", ["Ctrl", "⇧", "Z"]]]],
  ["Asistente IA", [["Abrir o cerrar el asistente", ["I"]], ["Recortar una zona (se pueden añadir varias)", ["X"]], ["Enviar pregunta / nueva línea", ["Enter", "⇧ Enter"]], ["Detener la respuesta o cerrar", ["Esc"]]]],
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
  mode: kv.getItem("paper.note-tool") || "text",
  ink: kv.getItem("paper.note-ink") || "black",
  highlight: kv.getItem("paper.note-highlight") || "yellow",
  width: kv.getItem("paper.note-width") || "medium",
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
    color: kv.getItem("paper.sticky-color") || "yellow",
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
  return RULER_HEIGHTS[kv.getItem("paper.ruler-size")] || RULER_HEIGHTS.medium;
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
  kv.setItem("paper.ruler", rulerOn ? "1" : "0");
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
  kv.setItem("paper.ruler-size", size);
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
    autoScroll.level = Math.max(0, Math.min(AUTOSCROLL_SPEEDS.length - 1, Number(kv.getItem("paper.autoscroll-level") ?? 3)));
    autoScroll.raf = requestAnimationFrame(autoScrollTick);
    toast("Auto-scroll: espacio pausa · [ ] velocidad");
  }
  updateAutoScrollUi();
}
function changeAutoScrollSpeed(delta) {
  autoScroll.level = Math.max(0, Math.min(AUTOSCROLL_SPEEDS.length - 1, autoScroll.level + delta));
  kv.setItem("paper.autoscroll-level", String(autoScroll.level));
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
  setRulerSize(kv.getItem("paper.ruler-size") || "medium");
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
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  board: '<rect x="3" y="3.5" width="18" height="13" rx="2"/><path d="M7 20.5 9.5 16.5M17 20.5l-2.5-4M7 12.5c1.5-3 3-3 4 0s2.5 3 4-1"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
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
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
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
  setIcon("captureBtn", "sparkles", "Asistente");
  $("captureBtn").title = "Asistente IA (I)";
  $("captureBtn").setAttribute("aria-label", "Asistente IA");
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
  return currentBook ? kv.getItem(key(currentBook.id, "doc-note")) || "" : "";
}
function writeDocumentNote(text) {
  if (!currentBook) return;
  if (text.trim()) kv.setItem(key(currentBook.id, "doc-note"), text.slice(0, 40000));
  else kv.removeItem(key(currentBook.id, "doc-note"));
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
    if (Object.keys(store).length) kv.removeItem(key(currentBook.id, "page-notes"));
    return 0;
  }
  const migrated = entries.map(([page, entry]) =>
    newNoteMark(Number(page), { note: String(entry.text).slice(0, 20000), createdAt: Number(entry.updatedAt) || Date.now() }),
  );
  commitAnnotations([...annotations(), ...migrated], false);
  kv.removeItem(key(currentBook.id, "page-notes"));
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
  kv.setItem("paper.note-tool", noteTool.mode);
  kv.setItem("paper.note-ink", noteTool.ink);
  kv.setItem("paper.note-highlight", noteTool.highlight);
  kv.setItem("paper.note-width", noteTool.width);
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
  kv.setItem("paper.notes-minimized", minimized ? "1" : "0");
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
    next.reviewedAt = Date.now();
    return next;
  }
  if (next.reps === 0) next.interval = grade === 3 ? 4 : grade === 1 ? 0.5 : 1;
  else if (next.reps === 1) next.interval = grade === 3 ? 8 : grade === 1 ? 3 : 6;
  else next.interval = Math.round(next.interval * (grade === 1 ? 1.2 : grade === 3 ? next.ease * 1.3 : next.ease) * 10) / 10;
  next.ease = Math.max(1.3, Math.min(3.2, next.ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0)));
  next.reps++;
  next.due = Date.now() + next.interval * DAY_MS;
  next.reviewedAt = Date.now();
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
  const text = captureReaderSelection()?.text;
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
  if (!localAiEngine && kv.getItem("paper.ai-webllm-consent") !== "1") throw new Error("Abre el asistente (I) y autoriza la descarga del modelo local para usar la IA.");
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
  setNotesMinimized(kv.getItem("paper.notes-minimized") === "1");
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
      kv.setItem("paper.sticky-color", next);
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
  kv.setItem(key(currentBook.id, "page"), String(currentPage));
  kv.setItem(key(currentBook.id, "scale"), String(scale));
  kv.setItem(key(currentBook.id, "rotation"), String(rotation));
  updateZoomLabel();
  updatePageChrome();
  if (anchor) restoreZoomAnchor(anchor);
  else if (resetScroll) $("viewer").scrollTo({ top: 0, left: 0 });
  await renderTextLayer(page, viewport);
  if (token !== renderToken || requestId !== pageRenderRequestId) return false;
  renderLinkLayer(page, viewport, token);
  if (reflowMode) {
    $("canvasWrap").hidden = true;
    $("reflowReader").hidden = false;
    await scrollToReflowPage(currentPage);
  }
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
// ---- Modo lectura continuo ----
// El modo lectura presenta todo el PDF como un único texto adaptable: una
// sección por página que se rellena al acercarse (y se queda rellena), con la
// misma tipografía, tamaño y ancho en todo el documento.
let reflowObserver = null;
let reflowBuiltFor = "";
let reflowScrollFrame = 0;
const reflowFilled = new Set();
function reflowTextHtml(text) {
  if (!searchRegex) return escapeHtml(text);
  const matcher = new RegExp(searchRegex.source, searchRegex.flags.includes("g") ? searchRegex.flags : `${searchRegex.flags}g`);
  let html = "",
    last = 0,
    match;
  while ((match = matcher.exec(text))) {
    if (!match[0]) {
      matcher.lastIndex++;
      continue;
    }
    html += `${escapeHtml(text.slice(last, match.index))}<mark class="search-hit">${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}
function reflowBlocksHtml(blocks) {
  return blocks
    .map((block) =>
      block.type === "list"
        ? `<ul>${block.items.map((text) => `<li>${reflowTextHtml(text)}</li>`).join("")}</ul>`
        : `<${block.type}>${reflowTextHtml(block.text)}</${block.type}>`,
    )
    .join("");
}
// Vuelve a pintar las páginas ya preparadas (p. ej. tras una búsqueda).
function refreshReflowSections() {
  if (!reflowMode || reflowBuiltFor !== currentBook?.id) return;
  const filled = [...reflowFilled];
  reflowFilled.clear();
  filled.forEach((page) => {
    const section = $("reflowReader").querySelector(`.reflow-page[data-page="${page}"]`);
    if (section) fillReflowSection(section);
  });
}
async function fillReflowSection(section) {
  const pageNumber = Number(section.dataset.page);
  if (reflowFilled.has(pageNumber) || !pdfDoc) return;
  reflowFilled.add(pageNumber);
  try {
    const page = await getCachedPage(pageNumber);
    const content = await getCachedTextContent(page);
    if (!reflowMode || !section.isConnected) return;
    const blocks = reflowBlocks(content.items);
    const viewer = $("viewer");
    const before = section.offsetHeight;
    const above = section.offsetTop + before <= viewer.scrollTop + 4;
    section.classList.remove("is-pending");
    section.querySelector(".reflow-page-body").innerHTML = blocks.length
      ? reflowBlocksHtml(blocks)
      : '<p class="reflow-empty-page">Esta página no contiene texto extraíble (puede ser una imagen o un escaneo).</p>';
    // Si la sección estaba por encima de lo visible, se compensa su cambio de
    // altura para que el texto que estás leyendo no salte.
    if (above) viewer.scrollTop += section.offsetHeight - before;
  } catch (error) {
    reflowFilled.delete(pageNumber);
    console.error("No se pudo preparar la página en modo lectura", error);
  }
}
async function ensureReflowDocument() {
  if (!pdfDoc || !currentBook) return;
  const reader = $("reflowReader");
  if (reflowBuiltFor === currentBook.id && reader.querySelector(".reflow-page")) return;
  reflowObserver?.disconnect();
  reflowFilled.clear();
  reflowBuiltFor = currentBook.id;
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const section = document.createElement("section");
    section.className = "reflow-page is-pending";
    section.dataset.page = String(i);
    section.innerHTML = `<div class="reflow-page-marker"><span>Página</span><strong>${i}</strong><small>de ${pdfDoc.numPages}</small></div><div class="reflow-page-body"><p class="reflow-skeleton"></p><p class="reflow-skeleton"></p><p class="reflow-skeleton short"></p></div>`;
    fragment.append(section);
  }
  reader.replaceChildren(fragment);
  reflowObserver = new IntersectionObserver(
    (entries) => entries.forEach((entry) => entry.isIntersecting && fillReflowSection(entry.target)),
    { root: $("viewer"), rootMargin: "1400px 0px" },
  );
  reader.querySelectorAll(".reflow-page").forEach((section) => reflowObserver.observe(section));
}
function teardownReflowDocument() {
  reflowObserver?.disconnect();
  reflowObserver = null;
  reflowFilled.clear();
  reflowBuiltFor = "";
  if (!markdownContent) $("reflowReader").replaceChildren();
}
async function scrollToReflowPage(pageNumber, options = {}) {
  await ensureReflowDocument();
  const section = $("reflowReader").querySelector(`.reflow-page[data-page="${pageNumber}"]`);
  if (!section) return;
  // Rellenar antes de desplazarse evita aterrizar en un hueco que luego crece.
  await fillReflowSection(section);
  syncCurrentFromScroll(pageNumber);
  $("viewer").scrollTo({ top: section.offsetTop - 8, behavior: options.smooth ? "smooth" : "auto" });
}
function onReflowScroll() {
  if (!reflowMode || !pdfDoc || reflowScrollFrame || reflowBuiltFor !== currentBook?.id) return;
  reflowScrollFrame = requestAnimationFrame(() => {
    reflowScrollFrame = 0;
    const viewer = $("viewer");
    const probe = viewer.scrollTop + Math.min(120, viewer.clientHeight * 0.2);
    let page = currentPage;
    for (const section of $("reflowReader").querySelectorAll(".reflow-page")) {
      if (section.offsetTop <= probe) page = Number(section.dataset.page);
      else break;
    }
    if (page !== currentPage) syncCurrentFromScroll(page);
  });
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
      anchor.setAttribute("aria-label", "Ir al destino del enlace");
      // Vista previa del destino (cita, figura, sección) sin salir de la página.
      anchor.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "touch") return;
        requestPreview(anchor.getBoundingClientRect(), `dest:${JSON.stringify(link.dest)}`, () => destPreview(link.dest));
      });
      anchor.addEventListener("pointerleave", scheduleHidePreview);
      anchor.addEventListener("click", async (event) => {
        hidePreview();
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

// ---- Vista previa al pasar el ratón ----
// Enlaces internos, citas («[12]», «Smith et al., 2019») y referencias a
// figuras o tablas muestran su destino en una ventanita, sin perder la página.
const hoverPreview = { el: null, showTimer: 0, hideTimer: 0, key: "", token: 0 };
const previewCanvasCache = new Map();
function previewElement() {
  if (hoverPreview.el) return hoverPreview.el;
  const el = document.createElement("div");
  el.className = "hover-preview";
  el.hidden = true;
  el.setAttribute("role", "tooltip");
  el.innerHTML = `<header><span class="hp-label"></span><span class="hp-actions"><button class="hp-split" type="button" title="Abrir en vista dividida" aria-label="Abrir en vista dividida">${iconSvg("split")}</button><button class="hp-go" type="button">Ir <span></span></button></span></header><div class="hp-body"></div>`;
  el.addEventListener("pointerenter", () => clearTimeout(hoverPreview.hideTimer));
  el.addEventListener("pointerleave", scheduleHidePreview);
  el.addEventListener("click", handleReferenceAction);
  document.body.append(el);
  hoverPreview.el = el;
  return el;
}
function scheduleHidePreview() {
  clearTimeout(hoverPreview.showTimer);
  clearTimeout(hoverPreview.hideTimer);
  hoverPreview.hideTimer = setTimeout(hidePreview, 240);
}
function hidePreview() {
  clearTimeout(hoverPreview.showTimer);
  hoverPreview.token++;
  hoverPreview.key = "";
  if (hoverPreview.el) hoverPreview.el.hidden = true;
}
function positionPreview(el, rect) {
  const width = el.offsetWidth || 480,
    height = el.offsetHeight || 280;
  const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.left + rect.width / 2 - width / 2));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
// `loader` devuelve { label, page, node, go } o null si no hay nada que mostrar.
function requestPreview(rect, key, loader, delay = 260) {
  clearTimeout(hoverPreview.hideTimer);
  if (hoverPreview.key === key && hoverPreview.el && !hoverPreview.el.hidden) return;
  clearTimeout(hoverPreview.showTimer);
  hoverPreview.showTimer = setTimeout(async () => {
    const token = ++hoverPreview.token;
    let content = null;
    try {
      content = await loader();
    } catch (error) {
      console.warn("No se pudo preparar la vista previa", error);
    }
    if (!content || token !== hoverPreview.token) return;
    const el = previewElement();
    el.querySelector(".hp-label").textContent = content.label;
    el.querySelector(".hp-go span").textContent = content.page ? `p. ${content.page}` : "";
    el.querySelector(".hp-go").onclick = () => {
      const from = currentPage;
      hidePreview();
      Promise.resolve(content.go?.()).then(() => currentPage !== from && showReturnChip(from));
    };
    const splitButton = el.querySelector(".hp-split");
    splitButton.hidden = !content.page;
    splitButton.onclick = () => {
      hidePreview();
      openSplitView({ page: content.page });
    };
    el.querySelector(".hp-body").replaceChildren(content.node);
    el.hidden = false;
    hoverPreview.key = key;
    positionPreview(el, rect);
  }, delay);
}
// Tras saltar a una referencia, un botón flotante devuelve a donde se leía.
let returnChipTimer = 0;
function showReturnChip(page) {
  let chip = $("returnChip");
  if (!chip) {
    chip = document.createElement("button");
    chip.id = "returnChip";
    chip.type = "button";
    chip.className = "return-chip";
    document.body.append(chip);
    chip.onclick = () => {
      hideReturnChip();
      navigateBack();
    };
  }
  chip.innerHTML = `${iconSvg("back")}<span>Volver a la p. ${page}</span>`;
  chip.hidden = false;
  clearTimeout(returnChipTimer);
  returnChipTimer = setTimeout(hideReturnChip, 12000);
}
function hideReturnChip() {
  clearTimeout(returnChipTimer);
  const chip = $("returnChip");
  if (chip) chip.hidden = true;
}
// Recorte de una página: `focusY` en coordenadas PDF; "above" deja el punto
// abajo (figuras, cuyo pie va debajo), "top" lo deja arriba.
async function pageCropNode(pageNumber, { focusY = null, align = "top", height = 230 } = {}) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation });
  // En el móvil la vista previa es más estrecha que 460 px.
  const width = Math.min(460, window.innerWidth - 22);
  const viewport = page.getViewport({ scale: width / base.width, rotation });
  const cacheKey = `${currentBook.id}:${pageNumber}:${rotation}:${width}`;
  let canvas = previewCanvasCache.get(cacheKey);
  if (!canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
    touchCache(previewCanvasCache, cacheKey, canvas, 16);
  }
  const visible = Math.min(height, viewport.height);
  let top = 0;
  if (Number.isFinite(focusY)) {
    const [, y] = viewport.convertToViewportPoint(0, focusY);
    top = align === "above" ? y - visible + 26 : align === "center" ? y - visible / 2 : y - 16;
  }
  top = Math.max(0, Math.min(viewport.height - visible, top));
  const frame = document.createElement("div");
  frame.className = "hp-page";
  frame.style.height = `${visible}px`;
  canvas.style.transform = `translateY(${-top}px)`;
  frame.append(canvas);
  return frame;
}
async function destPreview(dest) {
  if (!pdfDoc) return null;
  const explicit = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
  const page = await resolveDestPage(explicit);
  if (!page) return null;
  const mode = explicit?.[1]?.name;
  const top = mode === "XYZ" ? explicit[3] : mode === "FitH" || mode === "FitBH" ? explicit[2] : mode === "FitR" ? explicit[5] : null;
  return {
    label: `Destino del enlace · página ${page}`,
    page,
    node: await pageCropNode(page, { focusY: typeof top === "number" ? top : null, height: 210 }),
    go: () => jumpToPage(page),
  };
}
// Líneas de una página respetando las columnas (ver references.js).
async function pageLines(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const [x0, y0, x1] = page.view;
  const items = content.items.map((item) => ({ str: item.str, x: item.transform[4] - x0, y: item.transform[5] - y0, w: item.width, h: item.height || Math.abs(item.transform[3]) }));
  return buildLines(items, x1 - x0).map((line) => ({ ...line, y: line.y + y0 }));
}
const captionCache = new Map();
async function findCaption(kind, number) {
  const cacheKey = `${currentBook.id}:${kind}:${number}`;
  if (captionCache.has(cacheKey)) return captionCache.get(cacheKey);
  const pattern = captionPattern(kind, number);
  const loose = new RegExp(pattern.source.replace("^\\s*", "(?:^|\\s)"), "i");
  const indexed = currentDocPages();
  // Con el índice de texto se mira solo en las páginas candidatas; sin él,
  // en las cercanas a la actual.
  const candidates = indexed
    ? indexed.map((text, i) => (loose.test(text || "") ? i + 1 : 0)).filter(Boolean)
    : Array.from({ length: Math.min(pdfDoc.numPages, 61) }, (_, i) => Math.max(1, currentPage - 30) + i).filter((p) => p <= pdfDoc.numPages);
  let result = null;
  for (const p of candidates) {
    const line = (await pageLines(pdfDoc, p)).find((item) => pattern.test(item.text));
    if (line) {
      result = { page: p, y: line.y, size: line.size };
      break;
    }
  }
  touchCache(captionCache, cacheKey, result, 60);
  return result;
}
// Ecuación, enunciado o sección referidos dentro del documento: la línea que
// mejor encaja (ver anchorScore), empezando por las páginas que la contienen.
const anchorCache = new Map();
async function findAnchor(citation) {
  const cacheKey = `${currentBook.id}:${citation.kind}:${citation.word || ""}:${citation.number}`;
  if (anchorCache.has(cacheKey)) return anchorCache.get(cacheKey);
  const probe = anchorProbe(citation);
  const indexed = currentDocPages();
  const candidates = indexed
    ? indexed.map((text, i) => (probe.test(text || "") ? i + 1 : 0)).filter(Boolean)
    : Array.from({ length: Math.min(pdfDoc.numPages, 61) }, (_, i) => Math.max(1, currentPage - 30) + i).filter((p) => p <= pdfDoc.numPages);
  let best = null;
  for (const p of candidates.slice(0, 80)) {
    for (const line of await pageLines(pdfDoc, p)) {
      const score = anchorScore(citation, line.text);
      if (score && (!best || score > best.score)) best = { page: p, y: line.y, size: line.size, score };
    }
    if (best?.score >= 3) break;
  }
  touchCache(anchorCache, cacheKey, best, 80);
  return best;
}
function citationTitle(citation) {
  if (citation.kind === "equation") return `Ecuación (${citation.number})`;
  if (citation.kind === "section") return `Sección ${citation.number}`;
  return `${STATEMENT_LABELS[citation.word] || "Enunciado"} ${citation.number}`;
}
async function citationPreview(citation) {
  if (citation.kind === "equation" || citation.kind === "statement" || citation.kind === "section") {
    const hit = await findAnchor(citation);
    if (!hit) return null;
    const equation = citation.kind === "equation";
    return {
      label: `${citationTitle(citation)} · página ${hit.page}`,
      page: hit.page,
      node: await pageCropNode(hit.page, { focusY: hit.y + (equation ? hit.size / 2 : hit.size), align: equation ? "center" : "top", height: equation ? 170 : 280 }),
      go: () => jumpToPage(hit.page),
    };
  }
  if (citation.kind === "figure" || citation.kind === "table") {
    const hit = await findCaption(citation.kind, citation.number);
    if (!hit) return null;
    const figure = citation.kind === "figure";
    return {
      label: `${figure ? "Figura" : "Tabla"} ${citation.number} · página ${hit.page}`,
      page: hit.page,
      node: await pageCropNode(hit.page, { focusY: figure ? hit.y - hit.size * 0.3 : hit.y + hit.size, align: figure ? "above" : "top", height: 270 }),
      go: () => jumpToPage(hit.page),
    };
  }
  const entries = await ensureReferences();
  const hits = findEntryForCitation(entries, citation);
  if (!hits.length) return null;
  const node = document.createElement("div");
  node.className = "hp-refs";
  node.innerHTML = hits.map((entry) => referenceCardHtml(entry, true)).join("");
  return {
    label: hits.length > 1 ? `${hits.length} referencias` : `Referencia${hits[0].label ? ` [${hits[0].label}]` : ""} · página ${hits[0].page}`,
    page: hits[0].page,
    node,
    go: () => jumpToPage(hits[0].page),
  };
}
let textHoverFrame = 0;
// La cita, ecuación o enunciado bajo el punto (x, y) de un fragmento de texto.
function citationForSpan(span, x, y) {
  const text = span.textContent || "";
  if (text.length < 3) return null;
  let offset = null;
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret && span.contains(caret.offsetNode)) offset = caret.offset;
  else {
    const range = document.caretRangeFromPoint?.(x, y);
    if (range && span.contains(range.startContainer)) offset = range.startOffset;
  }
  // Las citas suelen partirse entre líneas («(Devlin» / «et al., 2019)»): se
  // analiza la línea junto con la anterior y la siguiente.
  const sibling = (node, direction) => {
    let next = direction < 0 ? node.previousElementSibling : node.nextElementSibling;
    while (next && next.tagName !== "SPAN") next = direction < 0 ? next.previousElementSibling : next.nextElementSibling;
    return next?.textContent || "";
  };
  const before = sibling(span, -1).slice(-80);
  const context = `${before} ${text} ${sibling(span, 1).slice(0, 80)}`;
  return offset === null ? null : citationAt(context, offset + before.length + 1);
}
function handleTextHover(span, x, y) {
  const citation = citationForSpan(span, x, y);
  if (!citation) {
    if (hoverPreview.key.startsWith("txt:")) scheduleHidePreview();
    return;
  }
  requestPreview(span.getBoundingClientRect(), `txt:${citation.kind}:${citation.label}`, () => citationPreview(citation));
}
// Con el dedo no hay «pasar por encima»: tocar una referencia la previsualiza.
function previewCitationAtTap(target, x, y) {
  const span = target.closest?.(".textLayer span");
  if (!span || !pdfDoc || reflowMode) return false;
  const citation = citationForSpan(span, x, y);
  if (!citation) return false;
  requestPreview(span.getBoundingClientRect(), `txt:${citation.kind}:${citation.label}`, () => citationPreview(citation), 0);
  return true;
}
function bindHoverPreviews() {
  $("viewer").addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" || event.buttons || !pdfDoc || markerMode || eraserMode || reflowMode) return;
    const span = event.target.closest?.(".textLayer span");
    if (!span) {
      if (hoverPreview.key.startsWith("txt:")) scheduleHidePreview();
      return;
    }
    if (textHoverFrame) return;
    const { clientX, clientY } = event;
    textHoverFrame = requestAnimationFrame(() => {
      textHoverFrame = 0;
      handleTextHover(span, clientX, clientY);
    });
  }, { passive: true });
  $("viewer").addEventListener("scroll", hidePreview, { passive: true });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".hover-preview")) hidePreview();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hidePreview();
  });
}

// ---- Referencias bibliográficas y cita del documento ----
let referencesCache = { id: "", entries: null, loading: null };
function ensureReferences() {
  if (!pdfDoc || !currentBook) return Promise.resolve([]);
  if (referencesCache.id === currentBook.id && referencesCache.entries) return Promise.resolve(referencesCache.entries);
  if (referencesCache.id === currentBook.id && referencesCache.loading) return referencesCache.loading;
  const doc = pdfDoc,
    id = currentBook.id;
  const loading = (async () => {
    const pages = [];
    // La bibliografía está al final: se analizan como mucho las 40 últimas.
    for (let p = Math.max(1, doc.numPages - 40); p <= doc.numPages; p++) pages.push({ page: p, lines: await pageLines(doc, p) });
    const entries = extractReferences(pages);
    if (referencesCache.id === id) referencesCache.entries = entries;
    return entries;
  })().catch((error) => {
    console.warn("No se pudieron extraer las referencias", error);
    return [];
  });
  referencesCache = { id, entries: null, loading };
  return loading;
}
let documentInfoCache = { id: "", info: null };
async function documentCitationInfo() {
  if (!pdfDoc || !currentBook) return null;
  if (documentInfoCache.id === currentBook.id && documentInfoCache.info) return documentInfoCache.info;
  const id = currentBook.id;
  const saved = getJSON(key(id, "citation"), null);
  let metadata = null;
  try {
    metadata = await pdfDoc.getMetadata();
  } catch {}
  const pdfInfo = metadata?.info || {};
  let xmp = "";
  try {
    xmp = JSON.stringify(metadata?.metadata?.getAll?.() || {});
  } catch {}
  const pages = currentDocPages();
  const firstText = pages ? pages.slice(0, 2).join(" ") : await getPagePlainText(1).catch(() => "");
  const doi = findDoi(`${pdfInfo.Subject || ""} ${xmp}`) || findDoi(firstText);
  const arxiv = findArxiv(firstText) || findArxiv(xmp) || findArxiv(doi);
  let title = String(pdfInfo.Title || "").trim();
  if (title.length < 4 || /\.(pdf|docx?|tex)$|^untitled|^microsoft word/i.test(title)) {
    // Sin título útil en los metadatos: la línea más grande de la portada.
    const lines = await pageLines(pdfDoc, 1).catch(() => []);
    const biggest = Math.max(0, ...lines.map((line) => line.size));
    title = lines.filter((line) => line.size >= biggest - 0.5).slice(0, 3).map((line) => line.text).join(" ");
  }
  // Los generadores de PDF rellenan a veces el autor con un valor genérico.
  const authorList = String(pdfInfo.Author || "")
    .split(/\s*[;,]\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name && !/^(anonymous|unknown|author|user|admin|owner|desconocido|usuario)$/i.test(name));
  // Año: el del identificador arXiv (AAMM.nnnnn) o la fecha de creación del
  // PDF. No se toma del texto: en la portada suelen aparecer años de citas.
  const year = (arxiv ? `20${arxiv.slice(0, 2)}` : "") || (String(pdfInfo.CreationDate || "").match(/D:(\d{4})/) || [])[1] || "";
  const info = {
    title,
    authorList,
    surnames: authorList.map((name) => (name.includes(",") ? name.split(",")[0] : name.split(/\s+/).pop())),
    year,
    doi: doi || (arxiv ? `10.48550/arXiv.${arxiv}` : ""),
    arxiv,
    ...(saved || {}),
  };
  documentInfoCache = { id, info };
  return info;
}
function referenceLinksHtml(meta) {
  const query = encodeURIComponent((meta.title || meta.text || "").slice(0, 200));
  return [
    meta.doi && `<a href="https://doi.org/${encodeURI(meta.doi)}" target="_blank" rel="noopener noreferrer">DOI</a>`,
    meta.arxiv && `<a href="https://arxiv.org/abs/${encodeURIComponent(meta.arxiv)}" target="_blank" rel="noopener noreferrer">arXiv</a>`,
    !meta.doi && !meta.arxiv && meta.url && `<a href="${escapeHtml(meta.url)}" target="_blank" rel="noopener noreferrer">Web</a>`,
    query && `<a href="https://scholar.google.com/scholar?q=${query}" target="_blank" rel="noopener noreferrer">Scholar</a>`,
  ].filter(Boolean).join("");
}
function referenceCardHtml(entry, compact = false) {
  return `<article class="ref-card${compact ? " is-compact" : ""}"><p class="ref-text">${entry.label ? `<b>[${escapeHtml(entry.label)}]</b> ` : ""}${escapeHtml(entry.text)}</p><div class="ref-links">${compact ? "" : `<button type="button" data-ref-action="go" data-ref-index="${entry.index}">p. ${entry.page}</button>`}${referenceLinksHtml(entry)}<button type="button" data-ref-action="copy" data-ref-index="${entry.index}">Copiar</button><button type="button" data-ref-action="bib" data-ref-index="${entry.index}">BibTeX</button></div></article>`;
}
async function copyToClipboard(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("No se pudo copiar al portapapeles");
  }
}
async function handleReferenceAction(event) {
  const button = event.target.closest?.("[data-ref-action]");
  if (!button) return;
  const entries = await ensureReferences();
  const entry = entries[Number(button.dataset.refIndex)];
  if (!entry) return;
  const action = button.dataset.refAction;
  if (action === "go") jumpToPage(entry.page);
  else if (action === "copy") copyToClipboard(entry.text, "Referencia copiada");
  else if (action === "bib") copyToClipboard(toBibtex(entry, bibKey(entry, `ref${entry.label || entry.index + 1}`)), "BibTeX copiado");
}
async function renderReferencesPanel() {
  const docBox = $("refsDoc"),
    list = $("refsList");
  if (!currentBook || !pdfDoc) {
    docBox.innerHTML = '<p class="refs-empty">Abre un PDF para ver su cita y su bibliografía.</p>';
    list.innerHTML = "";
    $("refsCount").textContent = "";
    return;
  }
  const id = currentBook.id;
  docBox.innerHTML = '<p class="refs-empty">Analizando el documento…</p>';
  const [info, entries] = await Promise.all([documentCitationInfo(), ensureReferences()]);
  if (currentBook?.id !== id) return;
  const who = info.authorList?.length ? info.authorList.join("; ") : "Autoría desconocida";
  docBox.innerHTML = `<div class="refs-doc-card"><small>Este documento</small><strong>${escapeHtml(info.title || libraryDisplayName(currentBook.name))}</strong><span>${escapeHtml(who)}${info.year ? ` · ${escapeHtml(info.year)}` : ""}${info.journal ? ` · ${escapeHtml(info.journal)}` : ""}</span><div class="ref-links">${referenceLinksHtml(info)}</div><div class="refs-actions"><button class="btn" data-refs="cite">Copiar cita</button><button class="btn" data-refs="doc-bib">Copiar BibTeX</button>${info.doi && !info.enriched ? '<button class="btn" data-refs="enrich" title="Consulta doi.org: solo se envía el DOI">Completar con doi.org</button>' : ""}</div></div>`;
  const query = normalizeText($("refsFilter").value.trim());
  const visible = query ? entries.filter((entry) => normalizeText(entry.text).includes(query)) : entries;
  $("refsCount").textContent = entries.length ? String(entries.length) : "";
  $("refsTools").hidden = !entries.length;
  list.innerHTML = entries.length
    ? visible.length
      ? visible.map((entry) => referenceCardHtml(entry)).join("")
      : '<p class="refs-empty">Ninguna referencia coincide.</p>'
    : '<p class="refs-empty">No se ha encontrado una sección de referencias en este PDF.</p>';
}
async function enrichDocumentCitation() {
  const info = await documentCitationInfo();
  if (!info?.doi) return;
  showLoader(true, "Consultando doi.org…", "Solo se envía el DOI del documento");
  try {
    const response = await fetch(`https://doi.org/${encodeURI(info.doi)}`, { headers: { Accept: "application/vnd.citationstyles.csl+json" } });
    if (!response.ok) throw new Error(`doi.org respondió ${response.status}`);
    const meta = { ...metaFromCsl(await response.json()), arxiv: info.arxiv, enriched: true };
    setJSON(key(currentBook.id, "citation"), meta);
    documentInfoCache = { id: "", info: null };
    toast("Datos de la cita completados");
    renderReferencesPanel();
  } catch (error) {
    console.warn("No se pudo consultar doi.org", error);
    toast("No se pudo consultar doi.org (¿sin conexión?)", 3000);
  } finally {
    showLoader(false);
  }
}
async function exportReferences(format) {
  const entries = await ensureReferences();
  const info = await documentCitationInfo();
  if (!entries.length && !info) return toast("No hay referencias que exportar");
  const base = libraryDisplayName(currentBook.name).replace(/[\\/:*?"<>|]+/g, "-");
  if (format === "dois") {
    const dois = entries.map((entry) => entry.doi || (entry.arxiv ? `arXiv:${entry.arxiv}` : "")).filter(Boolean);
    if (!dois.length) return toast("Ninguna referencia tiene DOI o arXiv");
    return copyToClipboard(dois.join("\n"), `${dois.length} identificadores copiados: pégalos en Zotero con «Añadir por identificador»`);
  }
  const records = [info ? { ...info, text: "" } : null, ...entries].filter(Boolean);
  if (format === "bib") {
    const used = new Set();
    const text = records.map((meta, i) => {
      let k = bibKey(meta, `ref${meta.label || i}`);
      while (used.has(k)) k += "a";
      used.add(k);
      return toBibtex(meta, k);
    }).join("\n\n");
    downloadText(`${base}-referencias.bib`, text, "application/x-bibtex");
  } else {
    downloadText(`${base}-referencias.ris`, records.map((meta) => toRis(meta)).join("\n\n"), "application/x-research-info-systems");
  }
  toast(`${records.length} referencias exportadas`);
}
function bindReferencesPanel() {
  $("sidebarRefsTab").onclick = () => setSidebarPanel("refs");
  $("refsFilterWrap").querySelector(".outline-filter-icon").innerHTML = iconSvg("search");
  $("refsFilter").addEventListener("input", () => renderReferencesPanel());
  $("sidebarRefsPanel").addEventListener("click", async (event) => {
    if (event.target.closest("[data-ref-action]")) return handleReferenceAction(event);
    const action = event.target.closest("[data-refs]")?.dataset.refs;
    if (!action) return;
    const info = await documentCitationInfo();
    if (action === "cite") copyToClipboard(formatCitation(info), "Cita copiada");
    else if (action === "doc-bib") copyToClipboard(toBibtex(info, bibKey(info, "documento")), "BibTeX del documento copiado");
    else if (action === "enrich") enrichDocumentCitation();
    else exportReferences(action);
  });
}

// ---- Vista dividida ----
// Un segundo lector independiente a la derecha: otro documento de la
// biblioteca o el mismo en otra página (la bibliografía, una figura…).
const split = { id: "", doc: null, own: false, zoom: 1, scale: 1, observer: null, rendered: new Set(), token: 0, frame: 0 };
function splitOpen() {
  return document.body.classList.contains("split-open");
}
function applySplitWidth() {
  const saved = Number(kv.getItem("paper.split-width")) || Math.round(window.innerWidth * 0.42);
  const main = document.querySelector(".main").getBoundingClientRect();
  const width = Math.max(280, Math.min(main.width - 320, saved));
  document.body.style.setProperty("--split-w", `${width}px`);
}
async function openSplitView({ id = currentBook?.id, page = currentPage } = {}) {
  if (!currentBook || !pdfDoc) return toast("Abre un PDF primero");
  if (window.innerWidth < 760) return toast("La vista dividida necesita una pantalla más ancha");
  if (boardOpen()) closeBoard();
  document.body.classList.add("split-open");
  $("splitPane").hidden = false;
  applySplitWidth();
  scheduleLayoutRefit();
  await loadSplitDocument(id || currentBook.id, page);
}
function closeSplitView() {
  split.token++;
  teardownSplitPages();
  if (split.own) split.doc?.destroy?.();
  Object.assign(split, { id: "", doc: null, own: false });
  $("splitPane").hidden = true;
  document.body.classList.remove("split-open");
  scheduleLayoutRefit();
}
function toggleSplitView() {
  splitOpen() ? closeSplitView() : openSplitView();
}
function teardownSplitPages() {
  split.observer?.disconnect();
  split.observer = null;
  split.rendered = new Set();
  $("splitPages").replaceChildren();
}
async function populateSplitSelect() {
  const records = (await dbAll()).filter((record) => record.kind !== "markdown").sort((a, b) => libraryDisplayName(a.name).localeCompare(libraryDisplayName(b.name), "es", { numeric: true }));
  $("splitDoc").innerHTML = records.map((record) => `<option value="${escapeHtml(record.id)}"${record.id === split.id ? " selected" : ""}>${escapeHtml(libraryDisplayName(record.name))}</option>`).join("");
}
async function loadSplitDocument(id, page = 1) {
  const token = ++split.token;
  let doc = null,
    own = false;
  if (id === currentBook?.id && pdfDoc) doc = pdfDoc;
  else {
    const record = await dbGet(id);
    if (!record || record.kind === "markdown") return toast("La vista dividida solo admite PDFs");
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await record.blob.arrayBuffer()) }).promise;
    own = true;
  }
  if (token !== split.token) {
    if (own) doc.destroy?.();
    return;
  }
  if (split.own && split.doc && split.doc !== doc) split.doc.destroy?.();
  Object.assign(split, { id, doc, own });
  populateSplitSelect();
  await buildSplitPages(page);
}
async function buildSplitPages(page = 1) {
  const doc = split.doc;
  if (!doc) return;
  teardownSplitPages();
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  // Margen interior más el hueco de la barra de desplazamiento vertical.
  const available = Math.max(200, $("splitScroll").clientWidth - 42);
  split.scale = Math.max(0.25, Math.min(4, (available / base.width) * split.zoom));
  const width = base.width * split.scale,
    height = base.height * split.scale;
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= doc.numPages; i++) {
    const slot = document.createElement("div");
    slot.className = "split-page";
    slot.dataset.page = String(i);
    slot.style.width = `${width}px`;
    slot.style.height = `${height}px`;
    slot.innerHTML = '<canvas></canvas><div class="textLayer"></div><div class="link-layer"></div>';
    fragment.append(slot);
  }
  $("splitPages").append(fragment);
  $("splitCount").textContent = `/ ${doc.numPages}`;
  $("splitPage").max = doc.numPages;
  split.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderSplitSlot(entry.target);
      else unloadSplitSlot(entry.target);
    }
  }, { root: $("splitScroll"), rootMargin: "300px 0px" });
  $("splitPages").querySelectorAll(".split-page").forEach((slot) => split.observer.observe(slot));
  splitScrollTo(page, false);
}
async function renderSplitSlot(slot) {
  const pageNumber = Number(slot.dataset.page);
  if (split.rendered.has(pageNumber) || !split.doc) return;
  split.rendered.add(pageNumber);
  const doc = split.doc;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: split.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = slot.querySelector("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    slot.style.width = `${viewport.width}px`;
    slot.style.height = `${viewport.height}px`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
    if (!split.rendered.has(pageNumber) || split.doc !== doc) return clearSplitSlot(slot);
    const textLayer = slot.querySelector(".textLayer");
    textLayer.replaceChildren();
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty("--scale-factor", String(viewport.scale));
    await new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: textLayer, viewport }).render();
    const links = (await page.getAnnotations({ intent: "display" })).filter((annotation) => annotation.subtype === "Link" && (annotation.url || annotation.dest));
    const layer = slot.querySelector(".link-layer");
    layer.replaceChildren(
      ...links.map((link) => {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(link.rect);
        const anchor = document.createElement("a");
        Object.assign(anchor.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
        if (link.url) {
          anchor.href = link.url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.className = "external";
        } else {
          anchor.href = "#";
          anchor.addEventListener("click", async (event) => {
            event.preventDefault();
            try {
              const target = typeof link.dest === "string" ? await doc.getDestination(link.dest) : link.dest;
              const index = typeof target?.[0] === "number" ? target[0] : await doc.getPageIndex(target[0]);
              splitScrollTo(index + 1);
            } catch {}
          });
        }
        return anchor;
      }),
    );
  } catch (error) {
    split.rendered.delete(pageNumber);
    if (error?.name !== "RenderingCancelledException") console.warn("No se pudo dibujar la página en la vista dividida", error);
  }
}
function unloadSplitSlot(slot) {
  const pageNumber = Number(slot.dataset.page);
  if (!split.rendered.has(pageNumber)) return;
  split.rendered.delete(pageNumber);
  clearSplitSlot(slot);
}
function clearSplitSlot(slot) {
  const canvas = slot.querySelector("canvas");
  canvas.width = 0;
  canvas.height = 0;
  slot.querySelector(".textLayer").replaceChildren();
  slot.querySelector(".link-layer").replaceChildren();
}
function splitCurrentPage() {
  const scroller = $("splitScroll");
  const slots = $("splitPages").children;
  if (!slots.length) return 1;
  const probe = scroller.scrollTop + scroller.clientHeight * 0.35;
  let lo = 0,
    hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].offsetTop + slots[mid].offsetHeight < probe) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}
function splitScrollTo(page, smooth = true) {
  const slot = $("splitPages").children[Math.max(1, Math.min(page, $("splitPages").children.length)) - 1];
  if (!slot) return;
  $("splitScroll").scrollTo({ top: slot.offsetTop - 10, behavior: smooth ? "smooth" : "auto" });
  $("splitPage").value = page;
}
function bindSplitView() {
  setIcon("splitClose", "close");
  setIcon("splitPrev", "chevronLeft");
  setIcon("splitNext", "chevronRight");
  setIcon("splitZoomOut", "minus");
  setIcon("splitZoomIn", "plus");
  $("splitClose").onclick = closeSplitView;
  $("splitViewBtn").onclick = () => {
    $("appearancePopover").classList.remove("open");
    toggleSplitView();
  };
  $("splitDoc").onchange = (event) => loadSplitDocument(event.target.value, 1);
  $("splitPrev").onclick = () => splitScrollTo(splitCurrentPage() - 1);
  $("splitNext").onclick = () => splitScrollTo(splitCurrentPage() + 1);
  $("splitPage").onchange = (event) => splitScrollTo(Number(event.target.value) || 1);
  const rezoom = (factor) => {
    const page = splitCurrentPage();
    split.zoom = Math.max(0.4, Math.min(3, split.zoom * factor));
    buildSplitPages(page);
  };
  $("splitZoomOut").onclick = () => rezoom(1 / 1.2);
  $("splitZoomIn").onclick = () => rezoom(1.2);
  $("splitScroll").addEventListener("scroll", () => {
    if (split.frame) return;
    split.frame = requestAnimationFrame(() => {
      split.frame = 0;
      if (document.activeElement !== $("splitPage")) $("splitPage").value = splitCurrentPage();
    });
  }, { passive: true });
  bindPaneResizer($("splitResizer"), () => {
    if (split.doc) buildSplitPages(splitCurrentPage());
  });
  window.addEventListener("resize", () => {
    if (!splitOpen()) return;
    if (window.innerWidth < 760) closeSplitView();
    else applySplitWidth();
  }, { passive: true });
}

// Arrastrar el borde izquierdo de un panel lateral (vista dividida o pizarra)
// cambia su ancho; ambos comparten el mismo ancho guardado.
function bindPaneResizer(resizer, onDone) {
  let drag = null;
  resizer.addEventListener("pointerdown", (event) => {
    drag = { id: event.pointerId };
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("split-resizing");
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const main = document.querySelector(".main").getBoundingClientRect();
    const width = Math.max(280, Math.min(main.width - 320, main.right - event.clientX));
    document.body.style.setProperty("--split-w", `${Math.round(width)}px`);
  });
  const finish = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    document.body.classList.remove("split-resizing");
    kv.setItem("paper.split-width", String(parseInt(getComputedStyle(document.body).getPropertyValue("--split-w"), 10) || 0));
    scheduleLayoutRefit();
    onDone?.();
  };
  resizer.addEventListener("pointerup", finish);
  resizer.addEventListener("pointercancel", finish);
}

// ---- Pizarra ----
// Panel junto al documento para escribir a mano (una pizarra por documento).
// Como en las notas, las coordenadas se guardan divididas por el ancho y `h` es
// alto/ancho. El lienzo solo cubre la zona visible y se redibuja al desplazarse,
// así la pizarra puede crecer hacia abajo sin gastar memoria de más.
const BOARD_COLORS = {
  dark: { yellow: "#ffd54a", white: "#f3f4f6", cyan: "#5cc8ff", pink: "#ff7eb3", green: "#7ddc8c" },
  light: { yellow: "#b77900", white: "#1f2328", cyan: "#1f6fd1", pink: "#cc2f6c", green: "#1f8a4c" },
};
const BOARD_BACKGROUNDS = { dark: "#16181d", light: "#fbfaf6" };
const BOARD_GRIDS = { none: "Liso", dots: "Puntos", lines: "Rayado", grid: "Cuadrícula" };
const BOARD_WIDTHS = { fine: 1.5, medium: 2.6, thick: 4.6 };
const board = { data: null, undo: [], redo: [], stroke: null, pan: null, drag: null, frame: 0, selected: null, penSeen: false, images: new Map(), bounds: new WeakMap() };
const boardTool = { mode: "pen", color: "yellow", width: "medium", ...getJSON("paper.board-tool", {}) };
function boardOpen() {
  return document.body.classList.contains("board-open");
}
function emptyBoard() {
  return { v: 1, bg: "dark", grid: "dots", h: 1.4, strokes: [], items: [] };
}
function boardStorageKey() {
  return currentBook ? key(currentBook.id, "board") : "";
}
function loadBoardData() {
  const stored = currentBook ? getJSON(boardStorageKey(), null) : null;
  const data = { ...emptyBoard(), ...(stored && typeof stored === "object" ? stored : {}) };
  data.strokes = Array.isArray(data.strokes) ? data.strokes.filter((stroke) => Array.isArray(stroke?.p) && stroke.p.length) : [];
  data.items = Array.isArray(data.items) ? data.items.filter((item) => item?.type === "image" && typeof item.src === "string") : [];
  if (!BOARD_BACKGROUNDS[data.bg]) data.bg = "dark";
  if (!BOARD_GRIDS[data.grid]) data.grid = "dots";
  board.data = data;
  board.undo = [];
  board.redo = [];
  board.selected = null;
}
function saveBoard() {
  if (!board.data || !currentBook) return;
  setJSON(boardStorageKey(), board.data);
  const status = $("boardStatus");
  if (status) status.textContent = "Guardado";
}
function pushBoardUndo(snapshot = JSON.stringify(board.data)) {
  board.undo.push(snapshot);
  if (board.undo.length > 60) board.undo.shift();
  board.redo = [];
  renderBoardTools();
}
// Aplica un cambio con deshacer, lo guarda y redibuja.
function commitBoard(change) {
  pushBoardUndo();
  change(board.data);
  saveBoard();
  refreshBoardHeight();
  paintBoard();
  renderBoardLinks();
}
function undoBoard(redo = false) {
  const from = redo ? board.redo : board.undo;
  const to = redo ? board.undo : board.redo;
  if (!from.length) return toast(redo ? "Nada que rehacer" : "Nada que deshacer en la pizarra");
  to.push(JSON.stringify(board.data));
  board.data = JSON.parse(from.pop());
  board.selected = null;
  saveBoard();
  refreshBoardHeight();
  paintBoard();
  renderBoardLinks();
  renderBoardTools();
}
// Parte más baja con contenido, en unidades de ancho.
function boardContentBottom() {
  let bottom = 0;
  for (const stroke of board.data?.strokes || []) bottom = Math.max(bottom, strokeBounds(stroke)[1]);
  for (const item of board.data?.items || []) bottom = Math.max(bottom, item.y + item.h);
  return bottom;
}
function strokeBounds(stroke) {
  let bounds = board.bounds.get(stroke);
  if (!bounds) {
    let min = Infinity;
    let max = -Infinity;
    for (const point of stroke.p) {
      min = Math.min(min, point[1]);
      max = Math.max(max, point[1]);
    }
    bounds = [min, max];
    board.bounds.set(stroke, bounds);
  }
  return bounds;
}
// La pizarra siempre deja al menos media pantalla libre bajo lo escrito.
function refreshBoardHeight() {
  const scroll = $("boardScroll");
  if (!board.data || !scroll) return;
  const width = Math.max(1, scroll.clientWidth);
  const view = scroll.clientHeight / width;
  board.data.h = Math.max(board.data.h || 0, view, boardContentBottom() + view * 0.6);
  $("boardSpacer").style.height = `${Math.max(0, Math.round(board.data.h * width - scroll.clientHeight))}px`;
}
function boardImage(src) {
  let image = board.images.get(src);
  if (!image) {
    image = new Image();
    image.onload = () => schedulePaintBoard();
    image.src = src;
    board.images.set(src, image);
  }
  return image;
}
function drawBoardGrid(ctx, width, height, top, data) {
  if (data.grid === "none") return;
  const step = width / 22;
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle = data.bg === "dark" ? "rgba(255,255,255,.13)" : "rgba(40,50,70,.14)";
  ctx.lineWidth = 1;
  const first = Math.ceil(top / step) * step - top;
  if (data.grid === "dots") {
    for (let y = first; y < height; y += step) for (let x = step / 2; x < width; x += step) ctx.fillRect(x - 1, y - 1, 2, 2);
  } else {
    ctx.beginPath();
    for (let y = first; y < height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    if (data.grid === "grid") for (let x = step / 2; x < width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    ctx.stroke();
  }
  ctx.restore();
}
function drawBoardContent(ctx, data, width, top, height, { live = null, selected = null, badges = null } = {}) {
  const palette = BOARD_COLORS[data.bg];
  ctx.save();
  ctx.translate(0, -top);
  for (const item of data.items) {
    const image = boardImage(item.src);
    if (image.complete && image.naturalWidth) {
      // Los recortes se funden con el fondo: sobre oscuro se invierten (tinta
      // clara) y el papel blanco deja ver la cuadrícula en ambos fondos.
      ctx.save();
      ctx.filter = data.bg === "dark" ? "invert(1) hue-rotate(180deg) brightness(.92)" : "none";
      ctx.globalCompositeOperation = data.bg === "dark" ? "lighten" : "multiply";
      ctx.drawImage(image, item.x * width, item.y * width, item.w * width, item.h * width);
      ctx.restore();
    }
    if (item.source && badges) {
      // Pastilla «p. N ↗» en la esquina: lleva a la zona original del PDF.
      const label = `p. ${item.source.page} ↗`;
      ctx.save();
      ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
      const bw = ctx.measureText(label).width + 16,
        bh = 22;
      const bx = Math.min((item.x + item.w) * width - bw - 4, width - bw - 6),
        by = item.y * width + 4;
      ctx.fillStyle = "#3b7cff";
      ctx.beginPath();
      ctx.roundRect?.(bx, by, bw, bh, 11) ?? ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + 8, by + bh / 2 + 0.5);
      ctx.restore();
      badges.push({ item, x: bx, y: by, w: bw, h: bh });
    }
    if (item.id === selected) {
      ctx.save();
      ctx.strokeStyle = "#3b7cff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(item.x * width - 3, item.y * width - 3, item.w * width + 6, item.h * width + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = "#3b7cff";
      ctx.fillRect((item.x + item.w) * width - 6, (item.y + item.h) * width - 6, 12, 12);
      ctx.restore();
    }
  }
  const from = top / width,
    to = (top + height) / width;
  for (const stroke of live ? [...data.strokes, live] : data.strokes) {
    const [min, max] = stroke === live ? [-Infinity, Infinity] : strokeBounds(stroke);
    if (max < from - 0.05 || min > to + 0.05) continue;
    drawInkStroke(ctx, { ...stroke, c: palette[stroke.c] || stroke.c }, width);
  }
  ctx.restore();
}
function schedulePaintBoard() {
  if (!board.frame) board.frame = requestAnimationFrame(paintBoard);
}
function paintBoard() {
  cancelAnimationFrame(board.frame);
  board.frame = 0;
  const data = board.data;
  const scroll = $("boardScroll");
  if (!data || !boardOpen() || !scroll) return;
  const canvas = $("boardCanvas");
  const width = scroll.clientWidth,
    height = scroll.clientHeight,
    dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BOARD_BACKGROUNDS[data.bg];
  ctx.fillRect(0, 0, width, height);
  drawBoardGrid(ctx, width, height, scroll.scrollTop, data);
  board.badges = [];
  drawBoardContent(ctx, data, width, scroll.scrollTop, height, { live: board.stroke, selected: board.selected, badges: board.badges });
  $("boardPane").dataset.bg = data.bg;
  $("boardEmpty").hidden = Boolean(data.strokes.length || data.items.length || board.stroke);
}
function renderBoardTools() {
  const tools = $("boardTools");
  if (!tools || !board.data) return;
  const palette = BOARD_COLORS[board.data.bg];
  const button = (attrs, icon, title, pressed = null) =>
    `<button type="button" class="btn icon" ${attrs} title="${title}" aria-label="${title}"${pressed === null ? "" : ` aria-pressed="${pressed}"`}>${iconSvg(icon)}</button>`;
  tools.innerHTML = `<div class="bd-group">${button('data-board-mode="pen"', "pen", "Lápiz", boardTool.mode === "pen")}${button('data-board-mode="eraser"', "eraser", "Goma (borra trazos enteros)", boardTool.mode === "eraser")}${button(
    'data-board-mode="move"',
    "cursor",
    "Mover y ajustar imágenes",
    boardTool.mode === "move",
  )}</div><div class="bd-group bd-colors">${Object.keys(palette)
    .map((name) => `<button type="button" class="bd-swatch" data-board-color="${name}" style="--swatch:${palette[name]}" aria-pressed="${boardTool.color === name}" title="Color" aria-label="Color ${name}"></button>`)
    .join("")}</div><div class="bd-group">${Object.keys(BOARD_WIDTHS)
    .map((name) => `<button type="button" class="bd-width" data-board-width="${name}" aria-pressed="${boardTool.width === name}" title="Grosor" aria-label="Grosor ${name}"><i style="--size:${BOARD_WIDTHS[name] * 1.6 + 1}px"></i></button>`)
    .join("")}</div><div class="bd-group">${button("data-board-undo", "back", "Deshacer (Ctrl+Z)")}${button("data-board-redo", "forward", "Rehacer (Ctrl+Shift+Z)")}${
    board.selected ? button("data-board-delete", "trash", "Quitar la imagen seleccionada (Supr)") : ""
  }</div><div class="bd-group">${button("data-board-crop", "crop", "Recortar una zona del PDF y pegarla aquí")}<select class="bd-select" data-board-grid aria-label="Fondo">${Object.entries(BOARD_GRIDS)
    .map(([id, label]) => `<option value="${id}" ${board.data.grid === id ? "selected" : ""}>${label}</option>`)
    .join("")}</select>${button("data-board-bg", board.data.bg === "dark" ? "sun" : "moon", board.data.bg === "dark" ? "Fondo claro" : "Fondo oscuro")}${button("data-board-export", "download", "Guardar como imagen PNG")}${button(
    "data-board-clear",
    "trash",
    "Borrar la pizarra",
  )}</div><span class="bd-status" id="boardStatus"></span>${button("data-board-close", "close", "Cerrar la pizarra (W)")}`;
  tools.querySelector("[data-board-undo]").disabled = !board.undo.length;
  tools.querySelector("[data-board-redo]").disabled = !board.redo.length;
  $("boardCanvas").dataset.mode = boardTool.mode;
}
function setBoardTool(patch) {
  Object.assign(boardTool, patch);
  setJSON("paper.board-tool", boardTool);
  if (patch.mode && patch.mode !== "move") board.selected = null;
  renderBoardTools();
  paintBoard();
}
function openBoard() {
  if (!currentBook) return toast("Abre un documento primero");
  if (splitOpen()) closeSplitView();
  document.body.classList.add("board-open");
  $("boardPane").hidden = false;
  $("boardBtn")?.setAttribute("aria-pressed", "true");
  applySplitWidth();
  scheduleLayoutRefit();
  if (!board.data) loadBoardData();
  renderBoardTools();
  refreshBoardHeight();
  paintBoard();
}
function closeBoard() {
  document.body.classList.remove("board-open");
  $("boardPane").hidden = true;
  $("boardBtn")?.setAttribute("aria-pressed", "false");
  board.stroke = null;
  board.selected = null;
  scheduleLayoutRefit();
}
function toggleBoard() {
  boardOpen() ? closeBoard() : openBoard();
}
function boardLoadDocument() {
  board.data = null;
  board.images.clear();
  // Se carga siempre: las zonas del PDF enlazadas a la pizarra se marcan
  // aunque la pizarra esté cerrada.
  if (currentBook) loadBoardData();
  renderBoardLinks();
  if (!boardOpen()) return;
  if (!currentBook) return closeBoard();
  $("boardScroll").scrollTop = 0;
  renderBoardTools();
  refreshBoardHeight();
  paintBoard();
}
// Pega una imagen (un recorte del PDF o una imagen del portapapeles) en la
// parte visible de la pizarra, debajo de lo que ya haya en pantalla.
// Cada fuente es una imagen o { src, page, rect } si viene de un recorte del
// PDF: entonces la imagen queda enlazada a su zona de origen.
async function insertBoardImages(sources) {
  if (!sources.length) return;
  if (!boardOpen()) openBoard();
  const scroll = $("boardScroll");
  const width = scroll.clientWidth;
  const loaded = await Promise.all(
    sources.map(
      (source) =>
        new Promise((resolve) => {
          const src = typeof source === "string" ? source : source.src;
          const origin = typeof source === "string" || !source.page ? null : { page: source.page, rect: source.rect };
          const image = new Image();
          image.onload = () => resolve({ src, image, origin });
          image.onerror = () => resolve(null);
          image.src = src;
        }),
    ),
  );
  let y = scroll.scrollTop / width + 0.04;
  const items = [];
  for (const entry of loaded.filter(Boolean)) {
    board.images.set(entry.src, entry.image);
    const w = Math.min(0.9, Math.max(0.45, entry.image.naturalWidth / width));
    const h = (w * entry.image.naturalHeight) / entry.image.naturalWidth;
    items.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, type: "image", src: entry.src, x: 0.05, y, w, h, ...(entry.origin ? { source: entry.origin } : {}) });
    y += h + 0.03;
  }
  if (!items.length) return toast("No se pudo pegar la imagen");
  commitBoard((data) => data.items.push(...items));
  board.selected = items.at(-1).id;
  setBoardTool({ mode: "move" });
  toast(items.length > 1 ? `${items.length} recortes pegados en la pizarra` : "Recorte pegado en la pizarra");
}
function boardHasContent() {
  return Boolean(board.data && (board.data.strokes.length || board.data.items.length));
}
async function exportBoardPng() {
  if (!boardHasContent()) return toast("La pizarra está vacía");
  const canvas = await renderBoardCanvas(1400);
  canvas.toBlob((blob) => {
    if (!blob) return toast("No se pudo crear la imagen");
    downloadBlob(`${(currentBook?.name || "documento").replace(/\.(pdf|md|markdown)$/i, "")}-pizarra.png`, blob);
  }, "image/png");
}
// La pizarra entera dibujada en un lienzo del ancho pedido.
async function renderBoardCanvas(width, minHeight = 0) {
  const data = board.data;
  const height = Math.max(minHeight, Math.min(20000, Math.round((boardContentBottom() + 0.06) * width)));
  await Promise.all(
    data.items.map((item) => {
      const image = boardImage(item.src);
      return image.complete ? null : new Promise((resolve) => image.addEventListener("load", resolve, { once: true }));
    }),
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BOARD_BACKGROUNDS[data.bg];
  ctx.fillRect(0, 0, width, height);
  drawBoardGrid(ctx, width, height, 0, data);
  drawBoardContent(ctx, data, width, 0, height);
  return canvas;
}
function boardItemAt(point) {
  for (let index = board.data.items.length - 1; index >= 0; index--) {
    const item = board.data.items[index];
    if (point[0] >= item.x && point[0] <= item.x + item.w && point[1] >= item.y && point[1] <= item.y + item.h) return item;
  }
  return null;
}
function bindBoard() {
  const pane = $("boardPane"),
    scroll = $("boardScroll"),
    canvas = $("boardCanvas");
  const pointFrom = (event) => {
    const box = canvas.getBoundingClientRect();
    const width = scroll.clientWidth;
    const pressure = event.pointerType === "pen" && event.pressure > 0 ? Math.round(event.pressure * 100) / 100 : 0;
    return [Math.round(((event.clientX - box.left) / width) * 10000) / 10000, Math.round(((event.clientY - box.top + scroll.scrollTop) / width) * 10000) / 10000, pressure];
  };
  let erasedFrom = null;
  const eraseAt = (point) => {
    const radius = 10 / scroll.clientWidth;
    const before = board.data.strokes.length;
    const kept = board.data.strokes.filter((stroke) => !stroke.p.some((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) < radius + (stroke.w / NOTE_INK_REF_WIDTH) / 2));
    if (kept.length === before) return;
    erasedFrom ||= JSON.stringify(board.data);
    board.data.strokes = kept;
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 0 || !board.data) return;
    if (event.pointerType === "pen") {
      lastPenInput = Date.now();
      board.penSeen = true;
    }
    // La pastilla de un recorte enlazado lleva a su origen con cualquier herramienta.
    const box = canvas.getBoundingClientRect();
    const bx = event.clientX - box.left,
      by = event.clientY - box.top + scroll.scrollTop;
    const badge = (board.badges || []).find((entry) => bx >= entry.x && bx <= entry.x + entry.w && by >= entry.y && by <= entry.y + entry.h);
    if (badge) {
      event.preventDefault();
      goToBoardSource(badge.item);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    // Con lápiz, el dedo desplaza la pizarra y la palma no escribe.
    if (event.pointerType === "touch" && (board.penSeen || Date.now() - lastPenInput < 2000)) {
      board.pan = { id: event.pointerId, y: event.clientY, top: scroll.scrollTop };
      return;
    }
    const point = pointFrom(event);
    if (boardTool.mode === "move") {
      const item = boardItemAt(point);
      const selected = board.data.items.find((entry) => entry.id === board.selected);
      const corner = selected && Math.hypot(point[0] - (selected.x + selected.w), point[1] - (selected.y + selected.h)) < 14 / scroll.clientWidth;
      const target = corner ? selected : item;
      board.selected = target?.id || null;
      board.drag = target ? { id: event.pointerId, item: target, start: point, from: { ...target }, resize: Boolean(corner), snapshot: JSON.stringify(board.data), moved: false } : null;
      if (!target) board.pan = { id: event.pointerId, y: event.clientY, top: scroll.scrollTop };
      renderBoardTools();
      paintBoard();
      return;
    }
    if (boardTool.mode === "eraser") {
      erasedFrom = null;
      eraseAt(point);
      paintBoard();
      return;
    }
    const width = scroll.clientWidth;
    board.stroke = { t: "pen", c: boardTool.color, w: (BOARD_WIDTHS[boardTool.width] * NOTE_INK_REF_WIDTH) / width, p: [point] };
    schedulePaintBoard();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!canvas.hasPointerCapture(event.pointerId) || !board.data) return;
    if (board.pan?.id === event.pointerId) {
      scroll.scrollTop = board.pan.top - (event.clientY - board.pan.y);
      return;
    }
    if (board.drag?.id === event.pointerId) {
      const point = pointFrom(event);
      const { item, from, start } = board.drag;
      const dx = point[0] - start[0],
        dy = point[1] - start[1];
      if (board.drag.resize) {
        item.w = Math.max(0.08, from.w + dx);
        item.h = (item.w * from.h) / from.w;
      } else {
        item.x = Math.max(-item.w * 0.8, Math.min(0.95, from.x + dx));
        item.y = Math.max(0, from.y + dy);
      }
      board.drag.moved = true;
      schedulePaintBoard();
      return;
    }
    const events = event.getCoalescedEvents?.() || [event];
    if (boardTool.mode === "eraser") {
      for (const item of events) eraseAt(pointFrom(item));
      schedulePaintBoard();
      return;
    }
    if (!board.stroke) return;
    for (const item of events) {
      const point = pointFrom(item);
      const last = board.stroke.p[board.stroke.p.length - 1];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.0015) board.stroke.p.push(point);
    }
    // Al escribir cerca del final, la pizarra crece.
    const bottom = board.stroke.p[board.stroke.p.length - 1][1];
    if (bottom > board.data.h - scroll.clientHeight / scroll.clientWidth / 3) {
      board.data.h = bottom + scroll.clientHeight / scroll.clientWidth;
      refreshBoardHeight();
    }
    schedulePaintBoard();
  });
  const finish = (event) => {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    canvas.releasePointerCapture(event.pointerId);
    if (board.pan?.id === event.pointerId) {
      board.pan = null;
      return;
    }
    if (board.drag?.id === event.pointerId) {
      if (board.drag.moved) {
        pushBoardUndo(board.drag.snapshot);
        saveBoard();
        refreshBoardHeight();
      }
      board.drag = null;
      paintBoard();
      return;
    }
    if (boardTool.mode === "eraser") {
      if (erasedFrom) {
        pushBoardUndo(erasedFrom);
        saveBoard();
      }
      erasedFrom = null;
      return;
    }
    if (board.stroke) {
      const stroke = board.stroke;
      board.stroke = null;
      commitBoard((data) => data.strokes.push(stroke));
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  scroll.addEventListener("scroll", schedulePaintBoard, { passive: true });
  new ResizeObserver(() => {
    if (!boardOpen()) return;
    refreshBoardHeight();
    paintBoard();
  }).observe(scroll);
  pane.addEventListener("change", (event) => {
    if (event.target.matches("[data-board-grid]")) commitBoard((data) => (data.grid = event.target.value));
  });
  pane.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    const data = target.dataset;
    if (data.boardMode) return setBoardTool({ mode: data.boardMode });
    if (data.boardColor) return setBoardTool({ color: data.boardColor, mode: "pen" });
    if (data.boardWidth) return setBoardTool({ width: data.boardWidth, mode: "pen" });
    if (data.boardUndo !== undefined) return undoBoard();
    if (data.boardRedo !== undefined) return undoBoard(true);
    if (data.boardDelete !== undefined) return deleteBoardSelection();
    if (data.boardCrop !== undefined) {
      const areas = captureAreas();
      return areas.length ? insertBoardImages(areas.map(areaBoardSource)) : openCapture({ toBoard: true });
    }
    if (data.boardBg !== undefined) {
      commitBoard((value) => (value.bg = value.bg === "dark" ? "light" : "dark"));
      return renderBoardTools();
    }
    if (data.boardExport !== undefined) return exportBoardPng();
    if (data.boardClear !== undefined) {
      if (!board.data.strokes.length && !board.data.items.length) return;
      if (!confirm("¿Borrar todo lo escrito en la pizarra? Podrás deshacerlo mientras no cierres el documento.")) return;
      board.selected = null;
      commitBoard((value) => {
        value.strokes = [];
        value.items = [];
      });
      return renderBoardTools();
    }
    if (data.boardClose !== undefined) closeBoard();
  });
  $("boardBtn").onclick = toggleBoard;
  $("viewer").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-board-item]");
    if (!button) return;
    event.stopPropagation();
    showBoardItem(button.dataset.boardItem);
  });
  setIcon("boardBtn", "board");
  // Ctrl+Z y Supr actúan sobre la pizarra si fue lo último que se tocó.
  document.addEventListener("pointerdown", (event) => (board.focused = Boolean(event.target.closest?.("#boardPane"))), true);
  // Pegar una imagen del portapapeles con la pizarra abierta.
  document.addEventListener("paste", (event) => {
    if (!boardOpen() || event.target.closest?.("input, textarea, [contenteditable]")) return;
    const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    const reader = new FileReader();
    reader.onload = () => insertBoardImages([reader.result]);
    reader.readAsDataURL(file);
  });
  bindPaneResizer($("boardResizer"), () => {
    refreshBoardHeight();
    paintBoard();
  });
}
function areaBoardSource(area) {
  return { src: area.image, page: area.page, rect: area.rect };
}
// Del recorte de la pizarra a su zona en el PDF, que parpadea al llegar.
async function goToBoardSource(item) {
  if (!item?.source || !pdfDoc) return;
  // En el móvil la pizarra ocupa toda la pantalla: se cierra para ver el PDF.
  if (window.innerWidth < 760) closeBoard();
  if (reflowMode) await setReadingMode("pdf");
  await jumpToPage(item.source.page);
  flashPdfRegion(item.source.page, item.source.rect);
}
function flashPdfRegion(page, rect, attempt = 0) {
  const host = areaHost(page);
  if (!host) {
    if (attempt < 8) setTimeout(() => flashPdfRegion(page, rect, attempt + 1), 150);
    return;
  }
  const flash = document.createElement("div");
  flash.className = "source-flash";
  Object.assign(flash.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
  host.append(flash);
  flash.scrollIntoView?.({ block: "center", behavior: "smooth" });
  setTimeout(() => flash.remove(), 1800);
}
// Marcas en el PDF sobre las zonas que están en la pizarra; su botón abre la
// pizarra justo en ese recorte.
function renderBoardLinks() {
  document.querySelectorAll(".board-link-mark").forEach((node) => node.remove());
  for (const item of board.data?.items || []) {
    if (!item.source?.rect) continue;
    const host = areaHost(item.source.page);
    if (!host) continue;
    const { rect } = item.source;
    const mark = document.createElement("div");
    mark.className = "board-link-mark";
    Object.assign(mark.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
    mark.innerHTML = `<button type="button" data-board-item="${escapeHtml(item.id)}" title="Ver en la pizarra" aria-label="Ver este fragmento en la pizarra">${iconSvg("board")}</button>`;
    host.append(mark);
  }
}
function showBoardItem(id) {
  if (!boardOpen()) openBoard();
  const item = board.data?.items.find((entry) => entry.id === id);
  if (!item) return;
  const scroll = $("boardScroll");
  scroll.scrollTop = Math.max(0, item.y * scroll.clientWidth - 40);
  board.selected = item.id;
  setBoardTool({ mode: "move" });
}
function deleteBoardSelection() {
  if (!board.selected) return false;
  const id = board.selected;
  board.selected = null;
  commitBoard((data) => (data.items = data.items.filter((item) => item.id !== id)));
  renderBoardTools();
  return true;
}

// ---- Abrir con Paper Reader y compartir ----
// Como app instalada, Paper Reader aparece en «Abrir con» para PDFs y
// Markdown (file_handlers) y como destino al compartir en el móvil
// (share_target: el service worker guarda los archivos y redirige aquí).
function bindLaunchQueue() {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params?.files?.length) return;
    const files = await Promise.all(params.files.map((handle) => handle.getFile().catch(() => null)));
    if (!$("libraryPanel").hidden) closeLibrary();
    await addFiles(files.filter(Boolean));
  });
}
async function consumeSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  history.replaceState(null, "", location.pathname);
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open("paper-share");
    const files = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        files.push(new File([blob], decodeURIComponent(response.headers.get("X-File-Name") || "documento.pdf"), { type: blob.type || "application/pdf" }));
      }
      await cache.delete(request);
    }
    if (files.length) await addFiles(files);
    else toast("No llegó ningún PDF compartido");
  } catch (error) {
    console.error("No se pudieron recibir los archivos compartidos", error);
    toast("No se pudieron recibir los archivos compartidos");
  }
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
  if (currentBook) kv.setItem(key(currentBook.id, "zoom-mode"), zoomMode);
}
async function applyZoomMode(mode = zoomMode, { persist = true } = {}) {
  if (!pdfDoc) return;
  zoomMode = mode;
  if (persist) persistZoomMode();
  if (mode === "custom" || reflowMode) {
    updateZoomLabel();
    return;
  }
  const next = await computeZoomForMode(mode);
  // Si el zoom no cambia (p. ej. el móvil solo ha ocultado la barra de
  // direcciones) no se redibuja nada: redibujar movía la lectura.
  if (next === scale) return updateZoomLabel();
  scale = next;
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
  const next = Math.max(14, Math.min(36, Number(kv.getItem("paper.reflow-size") || 20) + Math.sign(delta)));
  kv.setItem("paper.reflow-size", String(next));
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
// ---- PDF con las anotaciones dentro ----
// Se escriben como anotaciones PDF estándar (Highlight, Underline, StrikeOut,
// Squiggly, Ink, Square, Line y Text), con su apariencia dibujada, para que
// Acrobat, Preview, Zotero, GoodNotes o el visor de Chrome las muestren y
// permitan editarlas. La pizarra se añade como páginas al final.
const PDF_LIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
let pdfLibLoading = null;
function loadPdfLib() {
  if (globalThis.PDFLib) return Promise.resolve(globalThis.PDFLib);
  pdfLibLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDF_LIB_URL;
    script.onload = () => resolve(globalThis.PDFLib);
    script.onerror = () => {
      pdfLibLoading = null;
      reject(new Error("No se pudo cargar pdf-lib (¿sin conexión?)"));
    };
    document.head.append(script);
  });
  return pdfLibLoading;
}
const pdfNum = (value) => String(Math.round(value * 100) / 100);
const pdfPoints = (points) => points.map(pdfNum).join(" ");
function pdfRgb(color) {
  return (ANNOTATION_RGB[color] || ANNOTATION_RGB.yellow).map((value) => Math.round((value / 255) * 1000) / 1000);
}
function pdfDateString(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
function boundsOf(points, pad = 0) {
  const xs = points.map((point) => point[0]),
    ys = points.map((point) => point[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}
// Diccionario de la anotación (sin registrar) o null si no se puede exportar.
function pdfAnnotationFor(lib, context, mark, toPdf, extra) {
  const { PDFHexString } = lib;
  const opacity = Math.max(0.1, Math.min(1, Number(mark.opacity) || (mark.type === "highlight" || mark.type === "note" ? 0.48 : 0.85)));
  const color = pdfRgb(mark.type === "note" ? "blue" : mark.color);
  const rgb = color.join(" ");
  const appearance = (bbox, content, multiply = false) =>
    context.register(
      context.stream(content, {
        Type: "XObject",
        Subtype: "Form",
        BBox: bbox,
        Resources: { ExtGState: { GS0: { Type: "ExtGState", CA: opacity, ca: opacity, ...(multiply ? { BM: "Multiply" } : {}) } } },
      }),
    );
  const base = { Type: "Annot", F: 4, C: color, CA: opacity, T: PDFHexString.fromText("Paper Reader"), M: PDFHexString.fromText(extra.date), NM: PDFHexString.fromText(`paper-reader-${mark.id}`) };
  const note = String(mark.note || "").trim();
  if (note) base.Contents = PDFHexString.fromText(note);
  if (["highlight", "underline", "strike", "wavy", "note"].includes(mark.type)) {
    const quads = (mark.rects || []).map((r) => [toPdf(r.x, r.y), toPdf(r.x + r.w, r.y), toPdf(r.x, r.y + r.h), toPdf(r.x + r.w, r.y + r.h)]);
    if (!quads.length) return null;
    const bbox = boundsOf(quads.flat(), 3);
    let content = "/GS0 gs ";
    if (mark.type === "highlight" || mark.type === "note") {
      content += `${rgb} rg `;
      for (const [ul, ur, ll, lr] of quads) content += `${pdfPoints(ul)} m ${pdfPoints(ur)} l ${pdfPoints(lr)} l ${pdfPoints(ll)} l h f `;
    } else {
      content += `${rgb} RG 1 J 1 j `;
      for (const [ul, ur, ll, lr] of quads) {
        const height = Math.hypot(ul[0] - ll[0], ul[1] - ll[1]) || 1;
        const up = [(ul[0] - ll[0]) / height, (ul[1] - ll[1]) / height];
        const at = (point, lift) => [point[0] + up[0] * lift, point[1] + up[1] * lift];
        const width = Math.max(0.8, height * 0.075);
        content += `${pdfNum(width)} w `;
        if (mark.type === "strike") content += `${pdfPoints(at(ll, height * 0.45))} m ${pdfPoints(at(lr, height * 0.45))} l S `;
        else if (mark.type === "underline") content += `${pdfPoints(at(ll, height * 0.06))} m ${pdfPoints(at(lr, height * 0.06))} l S `;
        else {
          const length = Math.hypot(lr[0] - ll[0], lr[1] - ll[1]);
          const steps = Math.max(4, Math.round(length / (height * 0.18)));
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const point = at([ll[0] + (lr[0] - ll[0]) * t, ll[1] + (lr[1] - ll[1]) * t], i % 2 ? height * 0.1 : 0);
            content += `${pdfPoints(point)} ${i ? "l" : "m"} `;
          }
          content += "S ";
        }
      }
    }
    const subtype = { highlight: "Highlight", note: "Highlight", underline: "Underline", strike: "StrikeOut", wavy: "Squiggly" }[mark.type];
    return { ...base, Subtype: subtype, Rect: bbox, QuadPoints: quads.flatMap(([ul, ur, ll, lr]) => [...ul, ...ur, ...ll, ...lr]), AP: { N: appearance(bbox, content, mark.type === "highlight" || mark.type === "note") } };
  }
  if ((mark.type === "pen" || mark.type === "arrow") && mark.points?.length > 1) {
    const width = Math.max(0.5, Number(mark.width) || 3);
    const points = mark.points.map((point) => toPdf(point.x, point.y));
    const bbox = boundsOf(points, width + 6);
    if (mark.type === "arrow") {
      const [from, to] = [points[0], points.at(-1)];
      const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
      const head = (delta) => [to[0] - Math.cos(angle + delta) * width * 4, to[1] - Math.sin(angle + delta) * width * 4];
      const content = `/GS0 gs ${rgb} RG 1 J 1 j ${pdfNum(width)} w ${pdfPoints(from)} m ${pdfPoints(to)} l S ${pdfPoints(head(0.45))} m ${pdfPoints(to)} l ${pdfPoints(head(-0.45))} l S`;
      return { ...base, Subtype: "Line", Rect: bbox, L: [...from, ...to], LE: ["None", "OpenArrow"], BS: { W: width }, AP: { N: appearance(bbox, content) } };
    }
    const content = `/GS0 gs ${rgb} RG 1 J 1 j ${pdfNum(width)} w ${points.map((point, index) => `${pdfPoints(point)} ${index ? "l" : "m"}`).join(" ")} S`;
    return { ...base, Subtype: "Ink", Rect: bbox, InkList: [points.flat()], BS: { W: width }, AP: { N: appearance(bbox, content) } };
  }
  if (mark.type === "box" && mark.rects?.length) {
    const r = mark.rects[0];
    const width = Math.max(0.5, Number(mark.width) || 2);
    const [x0, y0, x1, y1] = boundsOf([toPdf(r.x, r.y), toPdf(r.x + r.w, r.y + r.h)]);
    const bbox = [x0 - width, y0 - width, x1 + width, y1 + width];
    const content = `/GS0 gs ${rgb} RG ${pdfNum(width)} w ${pdfNum(x0)} ${pdfNum(y0)} ${pdfNum(x1 - x0)} ${pdfNum(y1 - y0)} re S`;
    return { ...base, Subtype: "Square", Rect: bbox, BS: { W: width }, AP: { N: appearance(bbox, content) } };
  }
  return null;
}
// Nota de texto (icono de comentario) en un punto de la página.
function pdfTextNote(lib, point, text, color, id, date) {
  const { PDFHexString } = lib;
  return { Type: "Annot", Subtype: "Text", F: 4, Name: "Comment", Open: false, Rect: [point[0], point[1] - 20, point[0] + 20, point[1]], C: pdfRgb(color), Contents: PDFHexString.fromText(text), T: PDFHexString.fromText("Paper Reader"), M: PDFHexString.fromText(date), NM: PDFHexString.fromText(`paper-reader-${id}`) };
}
async function buildAnnotatedPdf({ includeBoard = true } = {}) {
  const lib = await loadPdfLib();
  const { PDFDocument, PDFName, PDFArray } = lib;
  const record = currentBook.blob ? currentBook : await dbGet(currentBook.id);
  const doc = await PDFDocument.load(new Uint8Array(await record.blob.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw Object.assign(new Error("El PDF está cifrado"), { code: "encrypted" });
  const context = doc.context;
  const pages = doc.getPages();
  const date = pdfDateString();
  const add = (page, dict) => {
    const ref = context.register(context.obj(dict));
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), context.obj([ref]));
  };
  // Las que se importaron del propio PDF ya están en el archivo original.
  const marks = annotations().filter((mark) => !String(mark.sourceId || "").startsWith("pdf:"));
  const pageNotes = pageNotesStore();
  const docNote = documentNote().trim();
  const pageNumbers = new Set([...marks.map((mark) => mark.page), ...Object.keys(pageNotes).map(Number), ...(docNote ? [1] : [])]);
  let count = 0;
  for (const pageNumber of [...pageNumbers].sort((a, b) => a - b)) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    const viewport = (await getCachedPage(pageNumber)).getViewport({ scale: 1, rotation });
    const toPdf = (x, y) => viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
    let margin = 0;
    const marginPoint = () => toPdf(0.015, 0.02 + 0.035 * margin++);
    for (const mark of marks.filter((item) => item.page === pageNumber)) {
      let dict = null;
      if (mark.type === "sticky") {
        const text = String(mark.note || "").trim();
        if (text) dict = pdfTextNote(lib, isPinned(mark) ? toPdf(mark.x, mark.y) : marginPoint(), text, mark.color || "yellow", mark.id, date);
      } else dict = pdfAnnotationFor(lib, context, mark, toPdf, { date });
      if (dict) {
        add(page, dict);
        count++;
      }
    }
    const pageText = String(pageNotes[pageNumber]?.text || "").trim();
    if (pageText) {
      add(page, pdfTextNote(lib, marginPoint(), pageText, "yellow", `page-${pageNumber}`, date));
      count++;
    }
    if (pageNumber === 1 && docNote) {
      add(page, pdfTextNote(lib, toPdf(0.94, 0.02), `Nota del documento\n\n${docNote}`, "blue", "document", date));
      count++;
    }
  }
  let boardPages = 0;
  if (includeBoard && boardHasContent()) {
    const width = 1240,
      sliceHeight = Math.round(width * Math.SQRT2);
    const canvas = await renderBoardCanvas(width, sliceHeight);
    for (let top = 0; top < canvas.height - 4; top += sliceHeight) {
      const slice = document.createElement("canvas");
      slice.width = width;
      slice.height = sliceHeight;
      const ctx = slice.getContext("2d");
      ctx.fillStyle = BOARD_BACKGROUNDS[board.data.bg];
      ctx.fillRect(0, 0, width, sliceHeight);
      ctx.drawImage(canvas, 0, -top);
      const image = await doc.embedJpg(await (await fetch(slice.toDataURL("image/jpeg", 0.88))).arrayBuffer());
      const page = doc.addPage([595.28, 841.89]);
      page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
      boardPages++;
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false }), count, boardPages };
}
async function exportAnnotatedPdf() {
  if (!pdfDoc || !currentBook || currentBook.kind === "markdown") return toast("Abre un PDF primero");
  showLoader(true, "Preparando el PDF anotado…", "Escribiendo las anotaciones en el documento");
  try {
    const { bytes, count, boardPages } = await buildAnnotatedPdf();
    if (!count && !boardPages) return toast("Este documento no tiene anotaciones que guardar");
    const name = `${currentBook.name.replace(/\.pdf$/i, "")}-anotado.pdf`;
    const file = new File([bytes], name, { type: "application/pdf" });
    const summary = `${count} ${count === 1 ? "anotación" : "anotaciones"}${boardPages ? ` y ${boardPages} página${boardPages === 1 ? "" : "s"} de pizarra` : ""}`;
    // En el móvil se ofrece compartir (GoodNotes, Files, Drive…); si no, se descarga.
    if (document.body.classList.contains("is-mobile") && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return toast(`PDF anotado listo: ${summary}`);
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadBlob(name, file);
    toast(`PDF anotado descargado: ${summary}`);
  } catch (error) {
    console.error("No se pudo crear el PDF anotado", error);
    toast(error?.code === "encrypted" ? "Este PDF está protegido y no se puede modificar" : `No se pudo crear el PDF anotado: ${error.message || error}`);
  } finally {
    showLoader(false);
  }
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
const ANNOTATION_RGB = {
  yellow: [255, 193, 7],
  green: [46, 160, 88],
  pink: [229, 72, 134],
  blue: [47, 112, 224],
  orange: [239, 123, 38],
  purple: [137, 74, 204],
  red: [218, 64, 64],
};
function annotationStyle(color, opacity) {
  const rgb = (ANNOTATION_RGB[color] || ANNOTATION_RGB.yellow).join(",");
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
  renderAreaMarks();
  renderBoardLinks();
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
  const selection = rememberReaderSelection();
  if (!selection || markerMode || eraserMode) {
    hideAnnotationActions();
    return;
  }
  const actions = $("annotationActions");
  actions.classList.toggle("is-main", selection.main);
  actions.classList.add("show");
  const r = selection.rect;
  const width = actions.offsetWidth || 360;
  const height = actions.offsetHeight || 40;
  actions.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, r.left + r.width / 2 - width / 2))}px`;
  const top = r.top > height + 70 ? r.top - height - 10 : r.bottom + 10;
  actions.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, top))}px`;
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
      if (persist) kv.setItem("paper.ink-position", JSON.stringify(next));
      positionInkColorCard();
    };
    const resetInkPosition = () => {
      strip.classList.remove("ink-positioned");
      colorCard.classList.remove("ink-positioned");
      strip.style.removeProperty("--ink-left");
      strip.style.removeProperty("--ink-top");
      kv.removeItem("paper.ink-position");
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
      const saved = JSON.parse(kv.getItem("paper.ink-position") || "null");
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top))
        requestAnimationFrame(() => setInkPosition(saved.left, saved.top));
    } catch {
      kv.removeItem("paper.ink-position");
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
// `append`: el recorte se suma a las áreas ya adjuntas en vez de sustituirlas.
async function openCapture({ append = false, toBoard = false } = {}) {
  if (!pdfDoc) return toast("Abre un PDF primero");
  if (reflowMode) await setReadingMode("pdf");
  closeCapture();
  closePromptMenu();
  hideAnnotationActions();
  captureAppend = append && captureAreas().length > 0;
  captureToBoard = toBoard;
  $("captureOverlay").querySelector(".capture-guide").textContent = toBoard
    ? "Arrastra sobre una zona del PDF para pegarla en la pizarra · Esc para cancelar"
    : captureAppend
    ? `Arrastra sobre otra zona para añadirla (área ${captureAreas().length + 1}) · Esc para cancelar`
    : "Arrastra sobre una fórmula, tabla o párrafo para recortarlo · Esc para cancelar";
  $("captureOverlay").classList.add("show");
  $("captureOverlay").setAttribute("aria-hidden", "false");
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
// ---- Áreas recortadas para la IA ---------------------------------------------
// Un área es una zona de una página: su imagen, el texto de la capa de texto que
// queda dentro y su posición relativa (0–1) para marcarla sobre la página.
const MAX_CAPTURE_AREAS = 4;
// Páginas dibujadas ahora mismo, en cualquier diseño: página, doble página o
// scroll continuo.
function capturePageTargets() {
  const targets = [];
  if (!$("canvasWrap").hidden) targets.push({ host: $("canvasWrap"), canvas: $("pdfCanvas"), textLayer: $("textLayer"), page: currentPage });
  if (!$("facingWrap").hidden) targets.push({ host: $("facingWrap"), canvas: $("facingCanvas"), textLayer: $("facingTextLayer"), page: currentPage + 1 });
  if (!$("continuousView").hidden)
    for (const slot of $("continuousView").querySelectorAll(".cont-page")) {
      const canvas = slot.querySelector("canvas");
      if (canvas?.width) targets.push({ host: slot, canvas, textLayer: slot.querySelector(".textLayer"), page: Number(slot.dataset.page) });
    }
  return targets;
}
function areaHost(page) {
  if (!$("continuousView").hidden) return $("continuousView").querySelector(`.cont-page[data-page="${page}"]`);
  if (page === currentPage && !$("canvasWrap").hidden) return $("canvasWrap");
  if (page === currentPage + 1 && !$("facingWrap").hidden) return $("facingWrap");
  return null;
}
// Texto de la capa de texto cuyo centro cae dentro del recorte, respetando los
// saltos de línea aproximados.
function textInsideRect(layer, clip) {
  if (!layer) return "";
  let text = "";
  let lastTop = null;
  for (const span of layer.querySelectorAll("span")) {
    const box = span.getBoundingClientRect();
    if (!box.width || !span.textContent) continue;
    const cx = box.left + box.width / 2,
      cy = box.top + box.height / 2;
    if (cx < clip.left || cx > clip.right || cy < clip.top || cy > clip.bottom) continue;
    if (lastTop !== null) text += box.top - lastTop > box.height * 0.6 ? "\n" : " ";
    text += span.textContent;
    lastTop = box.top;
  }
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim().slice(0, 3000);
}
// Vuelve a dibujar una zona de la página directamente desde el PDF, a unos
// 1600 px de ancho: fórmulas y letra pequeña salen nítidas aunque la página se
// esté viendo con poco zoom (la IA y la pizarra reciben una imagen legible).
async function renderPdfRegion(pageNumber, rect, targetWidth = 1600) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation });
  const area = rect.w * base.width * rect.h * base.height;
  const scale = Math.min(8, targetWidth / Math.max(1, rect.w * base.width), Math.sqrt(8e6 / Math.max(1, area)));
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w * viewport.width));
  canvas.height = Math.max(1, Math.round(rect.h * viewport.height));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -rect.x * viewport.width, -rect.y * viewport.height] }).promise;
  return canvas.toDataURL("image/jpeg", 0.9);
}
async function cropPdfCapture(a, b) {
  const sel = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
  // La página que más se solapa con el rectángulo dibujado.
  let target = null;
  let best = 0;
  for (const candidate of capturePageTargets()) {
    const box = candidate.canvas.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(box.right, sel.right) - Math.max(box.left, sel.left)) * Math.max(0, Math.min(box.bottom, sel.bottom) - Math.max(box.top, sel.top));
    if (overlap > best) {
      best = overlap;
      target = { ...candidate, box };
    }
  }
  if (!target) return toast("Arrastra sobre una página del PDF");
  const pageBox = target.box,
    clip = {
      left: Math.max(pageBox.left, sel.left),
      top: Math.max(pageBox.top, sel.top),
      right: Math.min(pageBox.right, sel.right),
      bottom: Math.min(pageBox.bottom, sel.bottom),
    };
  if (clip.right - clip.left < 20 || clip.bottom - clip.top < 20) return toast("Selecciona una zona más grande");
  const source = target.canvas,
    sx = ((clip.left - pageBox.left) * source.width) / pageBox.width,
    sy = ((clip.top - pageBox.top) * source.height) / pageBox.height,
    sw = ((clip.right - clip.left) * source.width) / pageBox.width,
    sh = ((clip.bottom - clip.top) * source.height) / pageBox.height,
    out = document.createElement("canvas"),
    captureScale = Math.min(1, 1600 / Math.max(sw, sh));
  out.width = Math.max(1, Math.round(sw * captureScale));
  out.height = Math.max(1, Math.round(sh * captureScale));
  const context = out.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, out.width, out.height);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const area = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    page: target.page,
    image: out.toDataURL("image/jpeg", 0.9),
    text: textInsideRect(target.textLayer, clip),
    rect: {
      x: (clip.left - pageBox.left) / pageBox.width,
      y: (clip.top - pageBox.top) / pageBox.height,
      w: (clip.right - clip.left) / pageBox.width,
      h: (clip.bottom - clip.top) / pageBox.height,
    },
  };
  const append = captureAppend;
  const toBoard = captureToBoard;
  closeCapture();
  captureAppend = false;
  captureToBoard = false;
  try {
    area.image = await renderPdfRegion(area.page, area.rect);
  } catch (error) {
    console.warn("Se usa la captura de pantalla del recorte", error);
  }
  if (toBoard) return insertBoardImages([areaBoardSource(area)]);
  const areas = append ? [...captureAreas(), area].slice(-MAX_CAPTURE_AREAS) : [area];
  setAssistantContext({ kind: "image", areas });
  const anchor = areaHost(area.page)?.querySelector(`.area-mark[data-area="${area.id}"]`)?.getBoundingClientRect();
  openPromptMenu({ kind: "image", areas }, anchor || { left: clip.left, right: clip.right, top: clip.top, bottom: clip.bottom, width: clip.right - clip.left, height: clip.bottom - clip.top });
}
function captureAreas() {
  return assistantContext.kind === "image" ? assistantContext.areas || [] : [];
}
function removeCaptureArea(id) {
  const areas = captureAreas().filter((area) => area.id !== id);
  setAssistantContext(areas.length ? { kind: "image", areas } : { kind: "page" });
}
// Recuadros numerados sobre las zonas adjuntas, para ver qué recibe la IA.
function renderAreaMarks() {
  document.querySelectorAll(".area-mark").forEach((node) => node.remove());
  captureAreas().forEach((area, index) => {
    const host = areaHost(area.page);
    if (!host) return;
    const mark = document.createElement("div");
    mark.className = "area-mark";
    mark.dataset.area = area.id;
    mark.style.left = `${area.rect.x * 100}%`;
    mark.style.top = `${area.rect.y * 100}%`;
    mark.style.width = `${area.rect.w * 100}%`;
    mark.style.height = `${area.rect.h * 100}%`;
    mark.innerHTML = `<span>${index + 1}</span>`;
    host.append(mark);
  });
}
// Varias áreas se envían al modelo visual como una sola imagen, apiladas y
// numeradas: funciona igual con la IA del navegador y con el modelo WebGPU.
async function composeAreaImage(areas) {
  if (areas.length === 1) return areas[0].image;
  const images = await Promise.all(
    areas.map(
      (area) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = area.image;
        }),
    ),
  );
  const label = 34,
    gap = 14,
    width = Math.min(1600, Math.max(...images.map((image) => image.naturalWidth)));
  const heights = images.map((image) => Math.round(image.naturalHeight * Math.min(1, width / image.naturalWidth)));
  let height = heights.reduce((sum, value) => sum + value + label + gap, 0);
  const scale = Math.min(1, 2400 / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  images.forEach((image, index) => {
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(0, y, width, label);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 20px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`Área ${index + 1} · página ${areas[index].page}`, 12, y + label / 2);
    y += label;
    const w = Math.min(width, image.naturalWidth);
    ctx.drawImage(image, 0, y, w, heights[index]);
    y += heights[index] + gap;
  });
  return canvas.toDataURL("image/jpeg", 0.88);
}
function areasText(areas) {
  return areas
    .map((area, index) => (area.text ? (areas.length > 1 ? `[Área ${index + 1} · p. ${area.page}]\n${area.text}` : area.text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

// ---- Menú flotante de prompts ------------------------------------------------
// Aparece junto a un recorte (o desde el menú de selección) con preguntas
// preparadas según el tipo de documento.
const PROMPT_PRESETS = {
  paper: { label: "Artículo científico", actions: ["stepwise", "symbols", "importance", "assumptions"] },
  general: { label: "General", actions: ["explain", "summary", "terms", "translate"] },
};
let promptMenuContext = null;
function promptPreset() {
  const value = kv.getItem("paper.prompt-preset");
  return PROMPT_PRESETS[value] ? value : "paper";
}
function promptMenuHtml(context) {
  const preset = promptPreset();
  const count = context.kind === "image" ? context.areas.length : 0;
  const footer =
    context.kind === "image"
      ? `${count} ${count === 1 ? "área adjunta" : "áreas adjuntas"}`
      : `Selección · ${countWords(context.text)} palabras · p. ${context.page}`;
  return `<header class="pm-head">${iconSvg("sparkles")}<select class="pm-preset" data-prompt-preset aria-label="Tipo de documento">${Object.entries(PROMPT_PRESETS)
    .map(([id, value]) => `<option value="${id}" ${id === preset ? "selected" : ""}>${value.label}</option>`)
    .join("")}</select></header><div class="pm-list" role="menu">${PROMPT_PRESETS[preset].actions
    .map((action) => `<button type="button" role="menuitem" data-prompt-action="${action}">${escapeHtml(ASSISTANT_ACTIONS[action].menu)}</button>`)
    .join("")}</div><div class="pm-sep"></div><div class="pm-list" role="menu">${
    context.kind === "image" && count < MAX_CAPTURE_AREAS ? `<button type="button" role="menuitem" data-prompt-add>${iconSvg("plus")}<span>Añadir otra área</span></button>` : ""
  }${
    context.kind === "image" ? `<button type="button" role="menuitem" data-prompt-board>${iconSvg("board")}<span>Pegar en la pizarra</span></button>` : ""
  }<button type="button" role="menuitem" data-prompt-ask>${iconSvg("send")}<span>Preguntar otra cosa…</span></button></div><footer class="pm-foot">${escapeHtml(footer)}</footer>`;
}
function openPromptMenu(context, anchor, { below = false } = {}) {
  let menu = $("promptMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "promptMenu";
    menu.className = "prompt-menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Preguntar a la IA");
    document.body.append(menu);
    bindPromptMenu(menu);
  }
  promptMenuContext = context;
  menu.innerHTML = promptMenuHtml(context);
  menu.hidden = false;
  const width = menu.offsetWidth,
    height = menu.offsetHeight;
  // A la derecha de la zona; si no cabe, a la izquierda; si tampoco, debajo.
  let left = anchor.right + 10;
  let top = anchor.top;
  if (below) {
    left = Math.min(window.innerWidth - width - 8, anchor.left);
    top = anchor.bottom + height + 18 < window.innerHeight ? anchor.bottom + 8 : anchor.top - height - 8;
  } else if (left + width > window.innerWidth - 8) {
    left = anchor.left - width - 10;
    if (left < 8) {
      left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.left));
      top = anchor.bottom + height + 18 < window.innerHeight ? anchor.bottom + 10 : anchor.top - height - 10;
    }
  }
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, top))}px`;
  menu.querySelector("[data-prompt-action]")?.focus({ preventScroll: true });
}
function closePromptMenu() {
  const menu = $("promptMenu");
  if (menu) menu.hidden = true;
  promptMenuContext = null;
}
function bindPromptMenu(menu) {
  menu.addEventListener("change", (event) => {
    if (!event.target.matches("[data-prompt-preset]")) return;
    kv.setItem("paper.prompt-preset", event.target.value);
    menu.innerHTML = promptMenuHtml(promptMenuContext);
    renderAssistantDock();
  });
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const context = promptMenuContext;
    if (!button || !context) return;
    closePromptMenu();
    if (button.dataset.promptAction) return runAssistantAction(button.dataset.promptAction, context);
    if (button.dataset.promptAdd !== undefined) return openCapture({ append: true });
    if (button.dataset.promptBoard !== undefined) return insertBoardImages(context.areas.map(areaBoardSource));
    if (button.dataset.promptAsk !== undefined) openAssistant({ context });
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePromptMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...menu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!menu.hidden && !menu.contains(event.target)) closePromptMenu();
    },
    true,
  );
  $("viewer").addEventListener("scroll", () => !menu.hidden && closePromptMenu(), { passive: true });
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
  if (!status) return;
  status.textContent = display;
  status.classList.toggle("is-loading", loading);
  status.style.setProperty("--ai-progress", `${Math.min(100, Number(percent || 0))}%`);
}
// ---- Asistente IA ------------------------------------------------------------
// Ventana de conversación con contexto explícito (selección, página, documento o
// recorte), acciones que se ejecutan al pulsarlas y límites de longitud por
// acción: un resumen nunca puede salir más largo que el texto que resume.
const ASSISTANT_ACTIONS = {
  summary: { label: "Resumir", done: "Resumen", menu: "Resúmelo" },
  explain: { label: "Explicar", done: "Explicación", menu: "Explícalo de forma sencilla" },
  keypoints: { label: "Ideas clave", done: "Ideas clave" },
  terms: { label: "Términos", done: "Términos", menu: "Define los términos clave" },
  questions: { label: "Preguntas", done: "Preguntas de estudio" },
  translate: { label: "Traducir", done: "Traducción", menu: "Tradúcelo" },
  stepwise: { label: "Paso a paso", done: "Explicación paso a paso", menu: "Explícalo con claridad y paso a paso" },
  symbols: { label: "Símbolos", done: "Definición y papel de cada símbolo", menu: "Define los símbolos y describe su papel" },
  importance: { label: "Importancia", done: "Papel en el argumento", menu: "¿Por qué es importante en el argumento del documento?" },
  assumptions: { label: "Supuestos", done: "Supuestos y consecuencias", menu: "¿En qué supuestos se basa y qué consecuencias tiene?" },
  describe: { label: "Describir", done: "Descripción" },
  transcribe: { label: "Transcribir", done: "Transcripción" },
  ask: { label: "Pregunta", done: "Respuesta" },
};
const ASSISTANT_TEXT_ACTIONS = ["summary", "explain", "keypoints", "terms", "questions", "translate"];
const ASSISTANT_IMAGE_ACTIONS = ["describe", "explain", "transcribe"];
// Acciones que necesitan ver el resto de la página para situar el fragmento.
const ASSISTANT_CONTEXT_ACTIONS = new Set(["ask", "stepwise", "symbols", "importance", "assumptions"]);
const ASSISTANT_SYSTEM =
  "Eres el asistente de lectura de Paper Reader. Respondes siempre en español (salvo que se pida traducir a otro idioma), con precisión y sin relleno. Usa solo la información del TEXTO proporcionado; si algo no aparece en él, dilo claramente. Escribe las fórmulas y los símbolos matemáticos en LaTeX, entre $…$ dentro de una frase o entre $$…$$ en su propia línea. No repitas el texto original ni estas instrucciones, y no empieces con frases como «Claro» o «El texto habla de».";
const READER_TEXT_SURFACES = "#textLayer, #facingTextLayer, #continuousView .textLayer, #reflowReader";
let assistantThread = [];
let assistantContext = { kind: "page" };
let assistantBusy = false;
let assistantAbort = null;
let assistantCapability = null;
let assistantRenderFrame = 0;
let lastReaderSelection = null;
const assistantImages = new Map();

function countWords(text) {
  return (String(text || "").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
// Texto seleccionado en cualquier superficie de lectura: página, página
// enfrentada, scroll continuo o modo lectura.
function readerSelectionNow() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const elementOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
  const anchor = elementOf(selection.anchorNode);
  const focus = elementOf(selection.focusNode);
  const surface = anchor?.closest?.(READER_TEXT_SURFACES);
  if (!surface || !focus?.closest?.(READER_TEXT_SURFACES)) return null;
  let page = currentPage;
  if (surface.id === "facingTextLayer") page = currentPage + 1;
  else {
    const holder = anchor.closest(".cont-page, .reflow-page");
    if (holder?.dataset.page) page = Number(holder.dataset.page) || currentPage;
  }
  return { text: text.slice(0, 12000), page, main: surface.id === "textLayer", rect: selection.getRangeAt(0).getBoundingClientRect() };
}
function rememberReaderSelection() {
  const selection = readerSelectionNow();
  if (selection) lastReaderSelection = { text: selection.text, page: selection.page, at: Date.now() };
  return selection;
}
// La selección actual o la última reciente (abrir la paleta o pulsar un botón
// puede colapsar la selección del documento antes de que la leamos).
function captureReaderSelection(maxAge = 30000) {
  const now = rememberReaderSelection();
  if (now) return { text: now.text, page: now.page };
  if (lastReaderSelection && Date.now() - lastReaderSelection.at < maxAge) return { text: lastReaderSelection.text, page: lastReaderSelection.page };
  return null;
}
function assistantStorageKey() {
  return currentBook ? key(currentBook.id, "assistant-thread") : "";
}
function saveAssistantThread() {
  const storageKey = assistantStorageKey();
  if (!storageKey) return;
  const stored = assistantThread
    .filter((message) => !message.pending && message.kind !== "consent")
    .slice(-40)
    .map(({ streaming, ...message }) => message);
  try {
    setJSON(storageKey, stored);
  } catch {}
}
function assistantLoadDocument() {
  assistantAbort?.abort();
  documentContextIndex = null;
  documentContextIndexId = currentBook?.id || "";
  documentIndexLoading = null;
  assistantImages.clear();
  lastReaderSelection = null;
  assistantThread = currentBook ? getJSON(assistantStorageKey(), []).filter((message) => message?.role && (message.content || message.error)) : [];
  assistantContext = { kind: "page" };
  closePromptMenu();
  renderAreaMarks();
  if (!$("assistantPanel")?.hidden) renderAssistant();
}
function assistantContextLabel(context) {
  if (!context) return "";
  if (context.kind === "selection") return `Selección · p. ${context.page}`;
  if (context.kind === "image") return context.count > 1 ? `${context.count} recortes · p. ${context.pages || context.page}` : `Recorte · p. ${context.page}`;
  if (context.kind === "document") return "Todo el documento";
  return currentBook?.kind === "markdown" ? "Documento" : `Página ${context.page || currentPage}`;
}
function setAssistantContext(context) {
  if (context.kind === "selection") {
    const selection = context.text ? context : captureReaderSelection();
    if (!selection?.text) {
      toast("Selecciona un fragmento del documento primero");
      return false;
    }
    assistantContext = { kind: "selection", text: selection.text, page: selection.page || currentPage };
  } else if (context.kind === "image") {
    const areas = context.areas || captureAreas();
    if (!areas.length) return false;
    assistantContext = { kind: "image", areas, page: areas[0].page };
  } else assistantContext = { kind: context.kind === "document" ? "document" : "page" };
  renderAreaMarks();
  renderAssistantDock();
  return true;
}
function setAssistantButton(active) {
  const button = $("captureBtn");
  if (!button) return;
  button.classList.toggle("assistant-on", active);
  button.setAttribute("aria-pressed", String(active));
}
async function refreshAssistantCapability() {
  const model = $("assistantModel");
  if (!model) return;
  model.dataset.state = "checking";
  model.querySelector("span").textContent = "Comprobando la IA local…";
  const capability = await inspectAiCapability();
  assistantCapability = capability;
  const consented = kv.getItem("paper.ai-webllm-consent") === "1";
  const [state, text] =
    capability.kind === "builtin"
      ? capability.availability === "available"
        ? ["ready", "IA del navegador · lista"]
        : ["download", "IA del navegador · se preparará al usarla"]
      : capability.kind === "webllm"
        ? localAiEngine
          ? ["ready", "Modelo local · listo"]
          : ["download", consented ? "Modelo local · se cargará al usarlo" : "Modelo local · requiere descarga (≈900 MB)"]
        : ["off", "IA local no disponible"];
  model.dataset.state = state;
  model.querySelector("span").textContent = text;
  model.title = capability.kind === "none" ? capability.reason : "Todo se procesa en este dispositivo; el documento no se envía a ningún servidor.";
  if (!assistantThread.length) renderAssistantThread();
}
function applyAssistantGeometry() {
  const panel = $("assistantPanel");
  if (window.innerWidth <= 700) {
    panel.style.cssText = "";
    return;
  }
  const saved = getJSON("paper.assistant-window", null);
  const topbar = 56;
  const width = Math.min(window.innerWidth - 24, Math.max(340, saved?.width || 420));
  const height = Math.min(window.innerHeight - topbar - 24, Math.max(360, saved?.height || Math.min(720, window.innerHeight - topbar - 90)));
  const notesOpen = !$("notebookPanel").hidden;
  const left = Number.isFinite(saved?.left) ? saved.left : window.innerWidth - width - 16 - (notesOpen ? 396 : 0);
  const top = Number.isFinite(saved?.top) ? saved.top : topbar + 12;
  panel.style.width = `${width}px`;
  panel.style.height = panel.classList.contains("is-minimized") ? "" : `${height}px`;
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - Math.min(width, 200) - 8, left))}px`;
  panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 52, top))}px`;
}
function saveAssistantGeometry() {
  const panel = $("assistantPanel");
  if (window.innerWidth <= 700 || panel.hidden) return;
  const box = panel.getBoundingClientRect();
  const saved = getJSON("paper.assistant-window", {});
  setJSON("paper.assistant-window", {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: panel.classList.contains("is-minimized") ? saved.height : Math.round(box.height),
  });
}
function setAssistantMinimized(minimized) {
  const panel = $("assistantPanel");
  panel.classList.toggle("is-minimized", minimized);
  setIcon("assistantMinimize", minimized ? "chevronUp" : "minus");
  $("assistantMinimize").title = minimized ? "Restaurar" : "Minimizar";
  applyAssistantGeometry();
}
function openAssistant(options = {}) {
  if (!currentBook) return toast("Abre un documento primero");
  const panel = $("assistantPanel");
  const wasHidden = panel.hidden;
  if (options.context) {
    if (!setAssistantContext(options.context)) return false;
  } else if (wasHidden) {
    const selection = captureReaderSelection(8000);
    if (selection) assistantContext = { kind: "selection", ...selection };
    else if (assistantContext.kind === "selection") assistantContext = { kind: "page" };
  }
  panel.hidden = false;
  if (panel.classList.contains("is-minimized")) setAssistantMinimized(false);
  if (wasHidden) applyAssistantGeometry();
  document.body.classList.add("assistant-open");
  setAssistantButton(true);
  hideAnnotationActions();
  renderAssistant();
  if (wasHidden || !assistantCapability) refreshAssistantCapability();
  if (options.focus !== false) requestAnimationFrame(() => $("assistantInput").focus({ preventScroll: true }));
  return true;
}
function closeAssistant() {
  assistantAbort?.abort();
  $("assistantPanel").hidden = true;
  document.body.classList.remove("assistant-open");
  setAssistantButton(false);
}
function toggleAssistant() {
  $("assistantPanel").hidden ? openAssistant() : closeAssistant();
}
function syncAssistantPage() {
  const panel = $("assistantPanel");
  if (!panel || panel.hidden || assistantContext.kind !== "page") return;
  renderAssistantDock();
}
// -- Render -------------------------------------------------------------------
// ---- Fórmulas en las respuestas (KaTeX, cargado solo cuando hace falta) ----
const KATEX_BASE = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/";
let katexLoading = null;
function loadKatex() {
  if (globalThis.katex) return Promise.resolve(globalThis.katex);
  katexLoading ||= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${KATEX_BASE}katex.min.css`;
    document.head.append(link);
    const script = document.createElement("script");
    script.src = `${KATEX_BASE}katex.min.js`;
    script.onload = () => {
      resolve(globalThis.katex);
      renderAssistantThread();
    };
    script.onerror = () => reject(new Error("No se pudo cargar KaTeX"));
    document.head.append(script);
  }).catch((error) => {
    console.warn(error);
    return null;
  });
  return katexLoading;
}
function renderTex(tex, display) {
  if (globalThis.katex) {
    try {
      return globalThis.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", output: "htmlAndMathml" });
    } catch {}
  } else loadKatex();
  // Hasta que KaTeX llega (o sin conexión) se muestra el código LaTeX.
  return `<code class="as-tex${display ? " is-display" : ""}">${escapeHtml(tex)}</code>`;
}
// Aparta las fórmulas ($…$, $$…$$, \(…\), \[…\]) antes de aplicar el formato
// de texto, para que `*` o `_` dentro de ellas no se tomen como Markdown.
function extractMath(text) {
  const math = [];
  const put = (tex, display) => `\u0000${math.push({ tex: tex.trim(), display }) - 1}\u0000`;
  const source = String(text || "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => put(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => put(tex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => put(tex, false))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, tex) => put(tex, false));
  return { source, math };
}
function formatAiAnswer(text) {
  const { source, math } = extractMath(text);
  text = source;
  const inline = (value) =>
    escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/[\[(](?:p\.|pág\.|página)\s*(\d{1,4})(?:\s*[-–,]\s*(\d{1,4}))?[\])]/gi, (match, first, second) => {
        const pages = [first, second].filter(Boolean);
        return pages.map((page) => `<button type="button" class="as-cite" data-page="${page}" title="Ir a la página ${page}">p. ${page}</button>`).join("");
      });
  let html = "";
  let list = "";
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = "";
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const qa = line.match(/^(?:\d+[.)]\s*)?P\s*:\s*(.+?)\s*\|\|\s*R\s*:\s*(.+)$/i);
    if (qa) {
      closeList();
      html += `<div class="as-qa"><strong>${inline(qa[1])}</strong><p>${inline(qa[2])}</p></div>`;
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      closeList();
      html += `<h4>${inline(line.replace(/^#{1,4}\s+/, ""))}</h4>`;
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      const kind = bullet[1] ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        html += `<${kind}>`;
        list = kind;
      }
      html += `<li>${inline(bullet[2])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return math.length ? html.replace(/\u0000(\d+)\u0000/g, (_, index) => renderTex(math[index].tex, math[index].display)) : html;
}
function renderAssistant() {
  renderAssistantThread();
  renderAssistantDock();
}
function assistantActionsFor(context) {
  const paper = promptPreset() === "paper";
  if (context.kind === "image") return paper ? [...PROMPT_PRESETS.paper.actions, "transcribe"] : ASSISTANT_IMAGE_ACTIONS;
  if (context.kind === "selection" && paper) return [...PROMPT_PRESETS.paper.actions, "summary", "translate"];
  return ASSISTANT_TEXT_ACTIONS;
}
function renderAssistantDock() {
  const panel = $("assistantPanel");
  if (!panel || panel.hidden) return;
  const context = assistantContext;
  const selection = context.kind === "selection" ? context : captureReaderSelection(8000);
  const isMarkdown = currentBook?.kind === "markdown";
  const scopes = [
    { kind: "selection", label: "Selección", disabled: !selection },
    { kind: "page", label: isMarkdown ? "Documento" : `Página ${currentPage}` },
    ...(isMarkdown ? [] : [{ kind: "document", label: "Todo el PDF" }]),
    ...(context.kind === "image" ? [{ kind: "image", label: context.areas.length > 1 ? `Recortes (${context.areas.length})` : "Recorte" }] : []),
  ];
  const quote =
    context.kind === "selection"
      ? `<div class="as-quote"><span>“${escapeHtml(context.text.length > 220 ? `${context.text.slice(0, 220)}…` : context.text)}”</span><small>${countWords(context.text)} palabras · p. ${context.page}</small><button type="button" class="as-quote-clear" data-assistant-clear title="Quitar la selección" aria-label="Quitar la selección">${iconSvg("close")}</button></div>`
      : context.kind === "image"
        ? `<div class="as-quote as-quote-image"><div class="as-areas">${context.areas
            .map(
              (area, index) =>
                `<figure><img src="${area.image}" alt="Área ${index + 1} del PDF"><figcaption>${index + 1} · p. ${area.page}</figcaption><button type="button" class="as-area-remove" data-area-remove="${escapeHtml(area.id)}" title="Quitar esta área" aria-label="Quitar el área ${index + 1}">${iconSvg("close")}</button></figure>`,
            )
            .join("")}${
            context.areas.length < MAX_CAPTURE_AREAS ? `<button type="button" class="as-area-add" data-area-add title="Añadir otra área" aria-label="Añadir otra área">${iconSvg("plus")}</button>` : ""
          }</div><small>${context.areas.length} ${context.areas.length === 1 ? "área adjunta" : "áreas adjuntas"}</small><button type="button" class="as-quote-clear" data-assistant-clear title="Quitar los recortes" aria-label="Quitar los recortes">${iconSvg("close")}</button></div>`
        : "";
  $("assistantContext").innerHTML = `<div class="as-scope" role="radiogroup" aria-label="Sobre qué preguntar">${scopes
    .map((scope) => `<button type="button" role="radio" data-assistant-scope="${scope.kind}" aria-checked="${scope.kind === context.kind}" ${scope.disabled ? "disabled title=\"Selecciona texto en el documento\"" : ""}>${scope.label}</button>`)
    .join("")}${pdfDoc ? `<button type="button" class="as-crop" data-assistant-crop title="Recortar una zona del PDF (imagen, tabla, fórmula…)" aria-label="Recortar una zona del PDF">${iconSvg("crop")}</button>` : ""}</div>${quote}`;
  $("assistantActions").innerHTML = assistantActionsFor(context)
    .map((action) => `<button type="button" class="as-chip" data-assistant-action="${action}" ${assistantBusy ? "disabled" : ""}>${ASSISTANT_ACTIONS[action].label}</button>`)
    .join("");
  const placeholders = {
    selection: "Pregunta sobre la selección…",
    page: isMarkdown ? "Pregunta sobre el documento…" : `Pregunta sobre la página ${currentPage}…`,
    document: "Pregunta sobre todo el documento…",
    image: "Pregunta sobre el recorte…",
  };
  $("assistantInput").placeholder = placeholders[context.kind];
  const send = $("assistantSend");
  send.classList.toggle("is-stop", assistantBusy);
  setIcon(send, assistantBusy ? "square" : "send");
  send.title = assistantBusy ? "Detener (Esc)" : "Enviar (Enter)";
  send.setAttribute("aria-label", send.title);
}
function assistantEmptyHtml() {
  const capability = assistantCapability;
  const unavailable = capability?.kind === "none";
  return `<div class="as-empty"><div class="as-empty-mark">${iconSvg("sparkles")}</div><strong>Tu asistente de lectura</strong><p>Elige sobre qué trabajar —una <b>selección</b>, la <b>página</b> o <b>todo el PDF</b>— y pulsa una acción o escribe una pregunta.</p><ul><li><b>Selecciona texto</b> en el documento y usa los botones que aparecen junto a él.</li><li>Las respuestas citan las páginas: pulsa <span class="as-cite">p. 4</span> para ir allí.</li><li>Todo se procesa en este dispositivo. Nada sale de tu navegador.</li></ul>${
    unavailable ? `<div class="as-warning"><strong>IA local no disponible</strong><p>${escapeHtml(capability.reason)}</p><p>Funciona en Chrome o Edge actualizados (IA integrada o WebGPU).</p></div>` : ""
  }</div>`;
}
function assistantMessageHtml(message, index) {
  if (message.role === "user") {
    const action = message.action && message.action !== "ask" ? ASSISTANT_ACTIONS[message.action]?.label : "";
    const quote = message.context?.quote ? `<blockquote>“${escapeHtml(message.context.quote)}”</blockquote>` : "";
    return `<article class="as-msg as-user" data-index="${index}"><div class="as-bubble">${action ? `<b class="as-action-tag">${action}</b>` : ""}${message.content && message.action === "ask" ? `<p>${escapeHtml(message.content)}</p>` : ""}<small>${escapeHtml(assistantContextLabel(message.context))}</small>${quote}</div></article>`;
  }
  if (message.kind === "consent") {
    return `<article class="as-msg as-bot as-consent" data-index="${index}"><div class="as-card"><strong>${message.vision ? "Descargar el modelo visual" : "Descargar el modelo de IA local"}</strong><p>${
      message.vision
        ? "Tu navegador no trae IA con visión. Para analizar recortes se descarga una vez un modelo de unos 4 GB que funciona con tu GPU."
        : "Tu navegador no trae IA integrada. Para usar el asistente se descarga una vez un modelo de unos 900 MB que funciona con tu GPU (WebGPU)."
    } Queda guardado en este dispositivo y el documento nunca se envía a ningún servidor.</p><div class="as-card-actions"><button type="button" class="btn primary" data-assistant-consent="${index}">Descargar y continuar</button><button type="button" class="btn" data-assistant-dismiss="${index}">Ahora no</button></div></div></article>`;
  }
  if (message.error) {
    return `<article class="as-msg as-bot as-error" data-index="${index}"><div class="as-card"><strong>No se pudo completar</strong><p>${escapeHtml(message.error)}</p>${message.request ? `<div class="as-card-actions"><button type="button" class="btn" data-assistant-retry="${index}">Reintentar</button></div>` : ""}</div></article>`;
  }
  const body = message.content ? formatAiAnswer(message.content) : "";
  const typing = message.pending && !message.content ? `<div class="as-typing"><i></i><i></i><i></i><span>${escapeHtml(message.phase || "Pensando…")}</span></div>` : "";
  const label = ASSISTANT_ACTIONS[message.action]?.done || "Respuesta";
  const sources = message.sources?.length
    ? `<div class="as-sources"><span>Fuentes</span>${message.sources.map((page) => `<button type="button" class="as-cite" data-page="${page}">p. ${page}</button>`).join("")}</div>`
    : "";
  const canRegenerate = message.request && (message.request.context.kind !== "image" || assistantImages.has(message.id));
  const tools = message.pending
    ? ""
    : `<footer class="as-tools">${message.meta ? `<span class="as-meta">${escapeHtml(message.meta)}</span>` : ""}<div>${
        message.action === "questions" ? `<button type="button" data-assistant-cards="${index}" title="Crear tarjetas de estudio">${iconSvg("check")}<span>Tarjetas</span></button>` : ""
      }<button type="button" data-assistant-copy="${index}" title="Copiar">${iconSvg("copy")}</button><button type="button" data-assistant-note="${index}" title="Guardar en las notas de la página">${iconSvg("sticky")}</button>${
        canRegenerate ? `<button type="button" data-assistant-retry="${index}" title="Generar de nuevo">${iconSvg("rotate")}</button>` : ""
      }</div></footer>`;
  return `<article class="as-msg as-bot${message.pending ? " is-pending" : ""}" data-index="${index}"><header><span>${iconSvg("sparkles")}${label}</span></header><div class="as-answer">${body}${typing}</div>${sources}${tools}</article>`;
}
function renderAssistantThread() {
  const thread = $("assistantThread");
  if (!thread || $("assistantPanel").hidden) return;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  thread.innerHTML = assistantThread.length ? assistantThread.map(assistantMessageHtml).join("") : assistantEmptyHtml();
  if (nearBottom || assistantBusy) thread.scrollTop = thread.scrollHeight;
}
function renderAssistantMessage(index) {
  cancelAnimationFrame(assistantRenderFrame);
  assistantRenderFrame = requestAnimationFrame(() => {
    const thread = $("assistantThread");
    const node = thread?.querySelector(`.as-msg[data-index="${index}"]`);
    if (!node) return renderAssistantThread();
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    node.outerHTML = assistantMessageHtml(assistantThread[index], index);
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  });
}
// -- Contexto y prompts -------------------------------------------------------
async function assistantPageText(pageNumber) {
  if (currentBook?.kind === "markdown") return String(markdownContent || "");
  if (!pdfDoc) return "";
  return getPagePlainText(pageNumber);
}
// Fragmentos repartidos por todo el documento, para resumir o estudiar el PDF
// completo sin superar la ventana de contexto de un modelo local.
function sampleDocumentChunks(chunks, budget = 8000) {
  if (!chunks.length) return [];
  const perChunk = Math.max(400, Math.floor(budget / Math.min(chunks.length, 12)));
  const count = Math.max(1, Math.min(chunks.length, Math.floor(budget / perChunk)));
  const picked = [];
  for (let index = 0; index < count; index++) picked.push(chunks[Math.floor((index * chunks.length) / count)]);
  return [...new Set(picked)].map((chunk) => ({ ...chunk, content: chunk.content.slice(0, perChunk) }));
}
async function assistantSourceText(context, action, question, signal) {
  if (context.kind === "selection" || context.kind === "image") {
    let extra = "";
    if (ASSISTANT_CONTEXT_ACTIONS.has(action)) {
      const page = (await assistantPageText(context.page).catch(() => "")).replace(/\s+/g, " ");
      if (page.length > context.text.length + 40) extra = page.slice(0, action === "importance" || action === "assumptions" ? 3000 : 1800);
    }
    const label = context.kind === "image" ? `texto extraído del recorte de la página ${context.pages || context.page}; la notación matemática puede estar incompleta` : `selección de la página ${context.page}`;
    return { text: context.text, extra, pages: String(context.pages || context.page).split(", ").map(Number), label };
  }
  if (context.kind === "page") {
    const page = currentBook?.kind === "markdown" ? 1 : context.page;
    const text = (await assistantPageText(page)).trim().slice(0, 7000);
    return { text, pages: currentBook?.kind === "markdown" ? [] : [page], label: currentBook?.kind === "markdown" ? "documento" : `página ${page}` };
  }
  const chunks = await ensureDocumentContextIndex(signal);
  if (action === "ask") {
    const ranked = rankAiChunks(chunks, question);
    const chosen = (ranked.filter((chunk) => chunk.score > 0.5).length ? ranked.filter((chunk) => chunk.score > 0.5) : ranked).slice(0, 6);
    const text = chosen.map((chunk) => `[p. ${chunk.page}]\n${chunk.content}`).join("\n\n").slice(0, 8000);
    return { text, pages: [...new Set(chosen.map((chunk) => chunk.page))].sort((a, b) => a - b), label: "fragmentos más relevantes del documento", cited: true };
  }
  const sample = sampleDocumentChunks(chunks, 8000);
  const text = sample.map((chunk) => `[p. ${chunk.page}]\n${chunk.content}`).join("\n\n");
  return { text, pages: [], label: "fragmentos repartidos por todo el documento", cited: true, sampled: true };
}
// Instrucción, límite de palabras y tokens para cada acción. El límite se pide
// al modelo y además se hace cumplir al recibir la respuesta.
function assistantPlan(action, words, source, question) {
  const doc = source.sampled;
  const cite = source.cited ? " Cita las páginas entre corchetes, por ejemplo [p. 3]." : "";
  let limit;
  let task;
  switch (action) {
    case "summary":
      limit = doc ? 220 : clampNumber(words * 0.3, 15, 170);
      task = `Resume el TEXTO en ${limit} palabras como máximo (el original tiene ${words}). ${
        limit <= 45 ? "Hazlo en una o dos frases." : "Usa un párrafo breve o, si ayuda, hasta 5 viñetas."
      } Conserva solo lo esencial y no añadas información externa ni opiniones.${doc ? " Los fragmentos proceden de distintas partes del documento: da una visión general." : ""}${cite}`;
      break;
    case "explain":
      limit = clampNumber(Math.max(words, 90), 90, 230);
      task = `Explica el TEXTO a alguien que lo lee por primera vez: qué quiere decir y por qué importa. Usa lenguaje sencillo y, si ayuda, un ejemplo breve. Máximo ${limit} palabras.${cite}`;
      break;
    case "keypoints": {
      const count = doc ? 6 : words < 120 ? 3 : words < 400 ? 4 : 5;
      limit = count * 24;
      task = `Enumera las ${count} ideas clave del TEXTO como viñetas que empiecen por «- », una frase corta cada una (máximo 20 palabras). No escribas nada más.${cite}`;
      break;
    }
    case "terms":
      limit = 190;
      task = `Extrae hasta 6 términos o conceptos importantes del TEXTO y defínelos según el propio texto. Formato por línea: «- **Término**: definición breve». Si no hay términos técnicos, dilo en una frase.${cite}`;
      break;
    case "questions": {
      const count = doc ? 5 : words < 150 ? 2 : 3;
      limit = count * 60;
      task = `Crea ${count} preguntas de estudio sobre el TEXTO con su respuesta breve y correcta. Escribe una por línea con este formato exacto: «P: pregunta || R: respuesta». No escribas nada más.`;
      break;
    }
    case "translate":
      limit = clampNumber(words * 1.5 + 20, 30, 1400);
      task = "Traduce el TEXTO al español. Si ya está en español, tradúcelo al inglés. Devuelve solo la traducción, conservando párrafos y listas, sin comentarios.";
      break;
    case "stepwise":
      limit = 300;
      task = `Explica el TEXTO con claridad y paso a paso: divide la explicación en pasos numerados («1. …»), justifica cada uno y termina con una frase de síntesis. Máximo ${limit} palabras.${cite}`;
      break;
    case "symbols":
      limit = 260;
      task = `Define cada símbolo o notación que aparece en el TEXTO y describe su papel. Una línea por símbolo con el formato «- $símbolo$: qué es · papel que cumple». Termina con una frase sobre qué expresa el conjunto. Máximo ${limit} palabras.`;
      break;
    case "importance":
      limit = 210;
      task = `Explica por qué el TEXTO es importante en el argumento del documento: qué papel cumple (definición, teorema, resultado principal, paso de una demostración…), en qué se apoya y qué permite hacer después. Usa el CONTEXTO ADICIONAL para situarlo. Máximo ${limit} palabras.${cite}`;
      break;
    case "assumptions":
      limit = 260;
      task = `Identifica en qué supuestos o hipótesis se basa el TEXTO (explícitos o implícitos) y qué consecuencias tiene. Usa dos apartados con los títulos «### Supuestos» y «### Consecuencias», con viñetas. Máximo ${limit} palabras.${cite}`;
      break;
    default:
      limit = /detall|extens|profund|todo|complet/i.test(question) ? 380 : 190;
      task = `Responde a la PREGUNTA usando el TEXTO. Empieza directamente por la respuesta, sé concreto y usa como máximo unas ${limit} palabras. Si la respuesta no está en el texto, dilo.${cite}`;
  }
  return { limit, hardLimit: Math.ceil(limit * 1.2) + 6, maxTokens: Math.min(1600, Math.ceil(limit * 2.1) + 60), task };
}
function assistantHistory() {
  const pairs = [];
  for (let index = assistantThread.length - 1; index > 0 && pairs.length < 2; index--) {
    const answer = assistantThread[index];
    const asked = assistantThread[index - 1];
    if (answer.role === "assistant" && answer.content && !answer.pending && asked.role === "user" && asked.action === "ask") {
      pairs.unshift(`Usuario: ${asked.content}\nAsistente: ${answer.content.slice(0, 600)}`);
      index--;
    }
  }
  return pairs.join("\n\n");
}
// Recorta al final de la última frase completa dentro del límite.
function trimToWords(text, limit) {
  const tokens = String(text).split(/(\s+)/);
  let words = 0;
  let cut = "";
  for (const token of tokens) {
    if (/\S/.test(token) && ++words > limit) break;
    cut += token;
  }
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n- "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (sentenceEnd > cut.length * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  return `${cut.trim().replace(/[,;:]$/, "")}…`;
}
// -- Motores ------------------------------------------------------------------
function consentError(vision = false) {
  const error = new Error("Se necesita permiso para descargar el modelo local.");
  error.name = "ConsentRequired";
  error.vision = vision;
  return error;
}
async function streamLocalText({ prompt, maxTokens, signal, onToken }) {
  const capability = await inspectAiCapability();
  if (capability.kind === "none") throw new Error(capability.reason);
  if (capability.kind === "builtin") {
    const base = await getBuiltInAi();
    if (!base) throw new Error("La IA integrada no está disponible.");
    // Cada petición usa una copia limpia: si no, el historial se acumula en la
    // sesión y las respuestas se contaminan con las anteriores.
    const session = base.clone ? await base.clone({ signal }) : base;
    try {
      let previous = "";
      for await (const chunk of session.promptStreaming(`${ASSISTANT_SYSTEM}\n\n${prompt}`, { signal })) {
        const value = String(chunk || "");
        const delta = previous && value.startsWith(previous) ? value.slice(previous.length) : value;
        previous = value.startsWith(previous) ? value : `${previous}${value}`;
        if (delta) onToken(delta);
      }
    } finally {
      if (session !== base) session.destroy?.();
    }
    return;
  }
  if (!localAiEngine && kv.getItem("paper.ai-webllm-consent") !== "1") throw consentError(false);
  const engine = await getWebLlmAi();
  aiStatus("");
  const stream = await engine.chat.completions.create({
    messages: [
      { role: "system", content: ASSISTANT_SYSTEM },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: true,
  });
  for await (const chunk of stream) {
    if (signal.aborted) {
      engine.interruptGenerate?.();
      throw new DOMException("Detenido", "AbortError");
    }
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) onToken(delta);
  }
}
async function streamLocalVision({ prompt, image, signal, onToken, maxTokens = 500 }) {
  const vision = await inspectVisionCapability();
  if (!vision.ok) throw new Error(vision.reason);
  if (vision.kind === "builtin") {
    try {
      const base = await getBuiltInVisionAi();
      const session = base.clone ? await base.clone({ signal }) : base;
      const blob = await fetch(image).then((response) => response.blob());
      try {
        let previous = "";
        const input = [{ role: "user", content: [{ type: "text", value: prompt }, { type: "image", value: blob }] }];
        for await (const chunk of session.promptStreaming(input, { signal })) {
          const value = String(chunk || "");
          const delta = previous && value.startsWith(previous) ? value.slice(previous.length) : value;
          previous = value.startsWith(previous) ? value : `${previous}${value}`;
          if (delta) onToken(delta);
        }
      } finally {
        if (session !== base) session.destroy?.();
      }
      return;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      builtInVisionSession = null;
      console.warn("La visión integrada falló; se intenta WebGPU", error);
    }
  }
  if (!visionAiEngine && kv.getItem("paper.ai-vision-consent") !== "1") throw consentError(true);
  const engine = await getVisionAi();
  const stream = await engine.chat.completions.create({
    messages: [
      { role: "system", content: "Eres un asistente de lectura visual riguroso. Responde siempre en español y distingue lo visible de tus inferencias." },
      { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: true,
  });
  for await (const chunk of stream) {
    if (signal.aborted) {
      engine.interruptGenerate?.();
      throw new DOMException("Detenido", "AbortError");
    }
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) onToken(delta);
  }
}
// Instrucción para el modelo visual. El texto de la capa de texto del PDF se
// añade como apoyo: ayuda a leer bien los símbolos que la imagen deja dudosos.
function visionPrompt(action, question, context, pageText = "") {
  const count = context.count || 1;
  const intro =
    count > 1
      ? `La imagen contiene ${count} recortes numerados de un documento (Área 1 a Área ${count}); tenlos en cuenta todos y di a qué área te refieres.`
      : "La imagen es un recorte de un documento (una fórmula, tabla, figura o párrafo).";
  const math = " Escribe las fórmulas y los símbolos en LaTeX entre $…$.";
  const tasks = {
    describe: "Describe con precisión lo que muestra: tipo de contenido (gráfico, tabla, diagrama, fórmula, texto…), elementos principales y lo que comunica. Máximo 160 palabras.",
    explain: "Explica qué significa su contenido y por qué es relevante, con lenguaje sencillo. Máximo 180 palabras." + math,
    transcribe: "Transcribe fielmente el texto visible, respetando líneas y listas; las fórmulas, en LaTeX entre $…$ o $$…$$. No añadas comentarios.",
    stepwise: "Explícalo con claridad y paso a paso: pasos numerados, cada uno con su justificación, y una frase final de síntesis. Máximo 260 palabras." + math,
    symbols: "Define cada símbolo o notación que aparece y describe su papel. Una línea por símbolo con el formato «- $símbolo$: qué es · papel que cumple». Termina con una frase sobre qué expresa el conjunto. Máximo 240 palabras.",
    importance: "Explica por qué es importante en el argumento del documento: qué papel cumple (definición, teorema, fórmula clave, paso de una demostración…), en qué se apoya y qué permite deducir después. Máximo 200 palabras." + math,
    assumptions: "Indica en qué supuestos o hipótesis se basa, explícitos o implícitos, y qué consecuencias tiene. Usa dos apartados con los títulos «### Supuestos» y «### Consecuencias» y viñetas. Máximo 240 palabras." + math,
    ask: `Responde a esta pregunta de forma concreta (máximo 200 palabras): ${question}` + math,
  };
  return [
    intro,
    tasks[action] || tasks.describe,
    context.text ? `Texto extraído del PDF en esa zona (la notación puede faltar o salir desordenada; úsalo solo como apoyo):\n"""\n${context.text.slice(0, 1500)}\n"""` : "",
    pageText ? `Contexto de la página (para situar el recorte en el argumento):\n"""\n${pageText}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
// -- Envío --------------------------------------------------------------------
function assistantRequestFromContext(action, question) {
  const context = assistantContext;
  if (context.kind === "selection") return { action, question, context: { kind: "selection", text: context.text, page: context.page } };
  if (context.kind === "image") {
    const pages = [...new Set(context.areas.map((area) => area.page))];
    return { action, question, areas: context.areas, context: { kind: "image", page: pages[0], pages: pages.join(", "), count: context.areas.length, text: areasText(context.areas) } };
  }
  if (context.kind === "document") return { action, question, context: { kind: "document" } };
  return { action, question, context: { kind: "page", page: currentBook?.kind === "markdown" ? 1 : currentPage } };
}
async function runAssistantAction(action, context) {
  if (!openAssistant({ context, focus: false })) return;
  await sendAssistant({ action });
}
async function sendAssistant({ action = "ask", question = "", request = null } = {}) {
  if (!currentBook || assistantBusy) return;
  request = request || assistantRequestFromContext(action, question.trim());
  action = request.action;
  question = (request.question || "").trim();
  if (action === "ask" && !question) return;
  const context = request.context;
  let image = "";
  if (context.kind === "image") {
    try {
      image = request.image || (request.areas?.length ? await composeAreaImage(request.areas) : "");
    } catch {}
    if (!image) return toast("El recorte ya no está disponible; vuelve a recortar la zona");
  }
  const quote = context.kind === "selection" ? (context.text.length > 180 ? `${context.text.slice(0, 180)}…` : context.text) : "";
  assistantThread.push({ role: "user", action, content: action === "ask" ? question : ASSISTANT_ACTIONS[action].label, context: { kind: context.kind, page: context.page, pages: context.pages, count: context.count, quote }, createdAt: Date.now() });
  const message = { id: crypto.randomUUID?.() || `${Date.now()}`, role: "assistant", action, content: "", pending: true, phase: "Preparando…", sources: [], request: { action, question, context }, createdAt: Date.now() };
  if (image) assistantImages.set(message.id, image);
  assistantThread.push(message);
  const index = assistantThread.length - 1;
  assistantBusy = true;
  assistantAbort = new AbortController();
  const signal = assistantAbort.signal;
  renderAssistant();
  const phase = (text) => {
    message.phase = text;
    if (!message.content) renderAssistantMessage(index);
  };
  let trimmed = false;
  let inputWords = 0;
  try {
    let plan;
    // Sin modelo visual, un recorte con texto extraíble se trabaja como texto.
    let useVision = context.kind === "image";
    if (useVision && countWords(context.text) >= 4) {
      const vision = await inspectVisionCapability().catch(() => ({ ok: false }));
      if (!vision.ok) useVision = false;
    }
    if (useVision) {
      const pageText = ASSISTANT_CONTEXT_ACTIONS.has(action) ? (await assistantPageText(context.page).catch(() => "")).replace(/\s+/g, " ").slice(0, 1200) : "";
      plan = { hardLimit: action === "transcribe" ? 900 : ["stepwise", "symbols", "assumptions"].includes(action) ? 330 : 260 };
      message.sources = String(context.pages || context.page).split(", ").map(Number);
      phase(context.count > 1 ? "Analizando los recortes…" : "Analizando el recorte…");
      await streamLocalVision({
        prompt: visionPrompt(action, question, context, pageText),
        image,
        signal,
        maxTokens: action === "transcribe" ? 1200 : 700,
        onToken: (delta) => {
          message.content += delta;
          renderAssistantMessage(index);
        },
      });
    } else {
      phase(context.kind === "document" ? "Leyendo el documento…" : "Leyendo el texto…");
      const source = await assistantSourceText(context, action, question, signal);
      inputWords = countWords(source.text);
      if (!inputWords) {
        message.content =
          context.kind === "selection"
            ? "La selección no contiene texto suficiente para trabajar con ella."
            : "Esta página no tiene texto extraíble: puede ser una imagen escaneada. Usa **Recortar** (el icono junto a los ámbitos) para analizar una zona como imagen.";
        message.local = true;
        return;
      }
      if (action === "summary" && inputWords < 30) {
        message.content = `El texto ya es muy breve (${inputWords} palabras), así que no tiene sentido resumirlo. Prueba **Explicar** si quieres entenderlo mejor.`;
        message.local = true;
        return;
      }
      plan = assistantPlan(action, inputWords, source, question);
      message.sources = source.pages;
      const history = action === "ask" ? assistantHistory() : "";
      const prompt = [
        `INSTRUCCIÓN: ${plan.task}`,
        `TEXTO (${source.label}):\n"""\n${source.text}\n"""`,
        source.extra ? `CONTEXTO ADICIONAL (resto de la página; úsalo solo si hace falta para entender el fragmento):\n"""\n${source.extra}\n"""` : "",
        history ? `CONVERSACIÓN PREVIA:\n${history}` : "",
        action === "ask" ? `PREGUNTA: ${question}` : "",
        "RESPUESTA:",
      ]
        .filter(Boolean)
        .join("\n\n");
      phase("Pensando…");
      const local = new AbortController();
      const stop = () => local.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        await streamLocalText({
          prompt,
          maxTokens: plan.maxTokens,
          signal: local.signal,
          onToken: (delta) => {
            message.content += delta;
            if (countWords(message.content) > plan.hardLimit) {
              trimmed = true;
              local.abort();
            }
            renderAssistantMessage(index);
          },
        });
      } catch (error) {
        if (!(trimmed && error?.name === "AbortError")) throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    }
    message.content = message.content.trim().replace(/^(?:RESPUESTA|Respuesta)\s*:\s*/, "");
    if (trimmed || (plan?.hardLimit && countWords(message.content) > plan.hardLimit)) {
      message.content = trimToWords(message.content, plan.limit || plan.hardLimit);
      trimmed = true;
    }
    if (!message.content) throw new Error("El modelo no devolvió ninguna respuesta. Inténtalo de nuevo.");
    const outWords = countWords(message.content);
    if (action === "summary" && inputWords) message.meta = `${inputWords} → ${outWords} palabras`;
    else if (trimmed) message.meta = "Acortada para respetar la longitud";
  } catch (error) {
    if (error?.name === "ConsentRequired") {
      assistantThread[index] = { role: "assistant", kind: "consent", vision: error.vision, request: message.request, imageId: message.id };
      return;
    }
    if (error?.name === "AbortError") {
      if (message.content.trim()) {
        message.content = message.content.trim();
        message.meta = "Detenida";
      } else assistantThread.splice(index - 1, 2);
      return;
    }
    console.error(error);
    assistantThread[index] = { role: "assistant", action, error: friendlyAiError(error, context.kind === "image"), request: message.request, id: message.id };
  } finally {
    message.pending = false;
    delete message.phase;
    assistantBusy = false;
    assistantAbort = null;
    aiStatus("");
    saveAssistantThread();
    renderAssistant();
  }
}
function retryAssistant(index) {
  const message = assistantThread[index];
  if (!message?.request || assistantBusy) return;
  const request = { ...message.request, image: assistantImages.get(message.id || message.imageId) };
  // Se sustituye el par pregunta/respuesta en vez de duplicarlo.
  const start = assistantThread[index - 1]?.role === "user" ? index - 1 : index;
  assistantThread.splice(start, index - start + 1);
  sendAssistant({ request });
}
async function copyAssistantMessage(index) {
  const content = assistantThread[index]?.content;
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    toast("Respuesta copiada");
  } catch {
    toast("No se pudo copiar");
  }
}
function saveAssistantToNotes(index) {
  const message = assistantThread[index];
  if (!message?.content || !currentBook) return;
  const page = message.request?.context?.page || message.sources?.[0] || currentPage;
  const label = ASSISTANT_ACTIONS[message.action]?.done || "Respuesta de la IA";
  const quote = message.request?.context?.kind === "selection" ? `> ${message.request.context.text.slice(0, 300)}\n\n` : "";
  const mark = newNoteMark(page, { note: `✦ ${label}\n\n${quote}${message.content}`.slice(0, 8000) });
  commitAnnotations([...annotations(), mark]);
  renderAnnotations();
  renderAnnotationList();
  toast(`Guardado en las notas de la página ${page}`);
}
function createCardsFromAssistant(index) {
  const message = assistantThread[index];
  if (!message?.content) return;
  const page = message.request?.context?.page || currentPage;
  const cards = message.content
    .split(/\n+/)
    .map((line) => line.match(/P\s*:\s*(.+?)\s*\|\|\s*R\s*:\s*(.+)/i))
    .filter(Boolean)
    .map((match) => newCard(match[1], match[2], { page, sourceKey: `ai:${page}:${hashText(match[1])}`, origin: "IA" }));
  const known = new Set(studyCards().map((card) => card.sourceKey));
  const fresh = cards.filter((card) => !known.has(card.sourceKey));
  if (!fresh.length) return toast(cards.length ? "Estas tarjetas ya están en tu mazo" : "No se encontraron preguntas con el formato esperado");
  saveStudyCards([...studyCards(), ...fresh]);
  toast(`${fresh.length} tarjeta${fresh.length > 1 ? "s" : ""} añadida${fresh.length > 1 ? "s" : ""} al estudio`);
}
function clearAssistantThread() {
  if (assistantBusy) assistantAbort?.abort();
  assistantThread = [];
  assistantImages.clear();
  const storageKey = assistantStorageKey();
  if (storageKey) kv.removeItem(storageKey);
  renderAssistant();
  $("assistantInput").focus();
}
function submitAssistantInput() {
  if (assistantBusy) {
    assistantAbort?.abort();
    return;
  }
  const input = $("assistantInput");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  autosizeAssistantInput();
  sendAssistant({ action: "ask", question });
}
function autosizeAssistantInput() {
  const input = $("assistantInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
}
function bindAssistant() {
  const panel = $("assistantPanel");
  setIcon("assistantNew", "trash");
  setIcon("assistantMinimize", "minus");
  setIcon("assistantClose", "close");
  $("assistantSpark").innerHTML = iconSvg("sparkles");
  $("assistantClose").onclick = closeAssistant;
  $("assistantMinimize").onclick = () => setAssistantMinimized(!panel.classList.contains("is-minimized"));
  $("assistantNew").onclick = clearAssistantThread;
  $("assistantComposer").addEventListener("submit", (event) => {
    event.preventDefault();
    submitAssistantInput();
  });
  $("assistantInput").addEventListener("input", autosizeAssistantInput);
  $("assistantInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!assistantBusy) submitAssistantInput();
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (assistantBusy) assistantAbort?.abort();
    else closeAssistant();
  });
  panel.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    const data = target.dataset;
    if (data.page) return jumpToPage(Number(data.page));
    if (data.assistantScope) {
      if (data.assistantScope === "image") return;
      setAssistantContext({ kind: data.assistantScope });
      return $("assistantInput").focus({ preventScroll: true });
    }
    if (data.assistantClear !== undefined) return setAssistantContext({ kind: "page" });
    if (data.assistantCrop !== undefined || data.areaAdd !== undefined) {
      closeAssistant();
      return openCapture({ append: data.areaAdd !== undefined });
    }
    if (data.areaRemove) return removeCaptureArea(data.areaRemove);
    if (data.assistantAction) return sendAssistant({ action: data.assistantAction });
    if (data.assistantCopy) return copyAssistantMessage(Number(data.assistantCopy));
    if (data.assistantNote) return saveAssistantToNotes(Number(data.assistantNote));
    if (data.assistantCards) return createCardsFromAssistant(Number(data.assistantCards));
    if (data.assistantRetry) return retryAssistant(Number(data.assistantRetry));
    if (data.assistantConsent) {
      const message = assistantThread[Number(data.assistantConsent)];
      kv.setItem(message.vision ? "paper.ai-vision-consent" : "paper.ai-webllm-consent", "1");
      return retryAssistant(Number(data.assistantConsent));
    }
    if (data.assistantDismiss) {
      const index = Number(data.assistantDismiss);
      assistantThread.splice(assistantThread[index - 1]?.role === "user" ? index - 1 : index, 2);
      saveAssistantThread();
      renderAssistant();
    }
  });
  // Arrastrar desde la cabecera, como la ventana de notas.
  let drag = null;
  const handle = $("assistantDragHandle");
  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") || window.innerWidth <= 700) return;
    const box = panel.getBoundingClientRect();
    drag = { id: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top };
    handle.setPointerCapture(event.pointerId);
    panel.classList.add("is-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 120, event.clientX - drag.dx))}px`;
    panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 52, event.clientY - drag.dy))}px`;
  });
  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    panel.classList.remove("is-dragging");
    saveAssistantGeometry();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) setAssistantMinimized(!panel.classList.contains("is-minimized"));
  });
  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (panel.hidden || panel.classList.contains("is-minimized")) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(saveAssistantGeometry, 250);
  }).observe(panel);
  window.addEventListener("resize", () => {
    if (!panel.hidden) applyAssistantGeometry();
  }, { passive: true });
  // Menú de selección: las acciones de IA se ejecutan con la selección exacta.
  const actions = $("annotationActions");
  actions.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-selection-ai]");
    if (!button) return;
    const selection = captureReaderSelection();
    if (!selection) return toast("Selecciona un fragmento primero");
    const anchor = actions.getBoundingClientRect();
    hideAnnotationActions();
    const context = { kind: "selection", ...selection };
    if (button.dataset.selectionAi === "menu") return openPromptMenu(context, anchor, { below: true });
    if (button.dataset.selectionAi === "ask") openAssistant({ context });
    else runAssistantAction(button.dataset.selectionAi, context);
  });
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
async function ensureDocumentContextIndex(signal) {
  if (!currentBook) return [];
  if (documentContextIndex && documentContextIndexId === currentBook.id) return documentContextIndex;
  if (documentIndexLoading && documentContextIndexId === currentBook.id) return documentIndexLoading;
  documentContextIndexId = currentBook.id;
  documentIndexLoading = (async () => {
    if (currentBook.kind === "markdown") return chunkAiText(markdownContent, 1);
    if (!pdfDoc) return [];
    const chunks = [];
    const indexed = currentDocPages();
    if (indexed) {
      indexed.forEach((text, index) => chunks.push(...chunkAiText(text, index + 1)));
      return chunks;
    }
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
  const indexed = currentDocPages();
  if (!indexed) showLoader(true, "Buscando…", `“${raw}”`);
  try {
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== searchToken) return;
      let text = indexed?.[i - 1];
      if (text == null) {
        const p = await getCachedPage(i);
        const tc = await getCachedTextContent(p);
        text = tc.items.map((x) => x.str).join(" ");
        $("loaderText").textContent = `Página ${i} de ${pdfDoc.numPages}`;
      }
      searchMatches.push(...collectPageMatches(text, regex, i));
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
  const records = (await dbAll()).filter((record) => record.blob);
  const cancelled = () => token !== searchToken || libToken !== librarySearchToken;
  showLoader(true, "Buscando en la biblioteca…", `“${raw}”`);
  try {
    for (let d = 0; d < records.length; d++) {
      if (cancelled()) return;
      const record = records[d];
      $("loaderText").textContent = `${record.name} · ${d + 1}/${records.length}`;
      try {
        // Cada documento se analiza una sola vez; después se busca en su
        // índice de texto guardado.
        let pages = record.id === currentBook?.id ? currentDocPages() : null;
        if (!pages) pages = (await getTextIndex(record.id))?.pages || null;
        if (!pages && record.kind === "markdown") pages = [await record.blob.text()];
        if (!pages) {
          const doc =
            currentBook?.id === record.id && pdfDoc
              ? pdfDoc
              : await pdfjsLib.getDocument({ data: new Uint8Array(await record.blob.arrayBuffer()) }).promise;
          try {
            pages = await extractDocumentText(doc, {
              isCancelled: cancelled,
              onProgress: (page, total) => {
                if (page % 10 === 0 || page === total) $("loaderText").textContent = `Indexando ${record.name} · página ${page} de ${total}`;
              },
            });
          } finally {
            if (doc !== pdfDoc) doc.destroy?.();
          }
          if (!pages) return;
          putTextIndex(record.id, pages).catch(() => {});
        }
        pages.forEach((text, i) => searchMatches.push(...collectPageMatches(text || "", regex, i + 1, { docId: record.id, docName: record.name })));
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
  refreshReflowSections();
  searchIndex = index;
  const match = searchMatches[index];
  if (match.docId && (match.docId !== currentBook?.id || requestedDocId !== match.docId)) {
    preserveSearchOnOpen = true;
    await openStored(match.docId);
    if (currentBook?.id !== match.docId) return;
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
  const panels = { contents: ["sidebarContentsPanel", "sidebarContentsTab"], notes: ["sidebarNotesPanel", "sidebarNotesTab"], refs: ["sidebarRefsPanel", "sidebarRefsTab"] };
  if (!panels[panel]) panel = "contents";
  for (const [name, [panelId, tabId]] of Object.entries(panels)) {
    $(panelId).hidden = name !== panel;
    $(tabId).classList.toggle("active", name === panel);
    $(tabId).setAttribute("aria-selected", String(name === panel));
  }
  if (panel === "refs") renderReferencesPanel();
}
$("fileInput").onchange = async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  await addFiles(files);
};
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
  kv.setItem("paper.theme", theme);
  syncThemeColor();
  $("themeSelect").value = theme;
  $("appearanceTheme").value = theme;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.classList.toggle("active", button.dataset.themeChoice === theme));
}
// ---- Menú «Más» del móvil ----
// La cabecera del móvil solo muestra buscar, IA, Ink y Vista; el resto de
// herramientas que en escritorio están en la barra se abren desde aquí.
function mobileMoreItems() {
  const hasDoc = Boolean(currentBook);
  const hasPdf = Boolean(pdfDoc);
  const marked = hasDoc && getJSON(key(currentBook.id, "bookmarks"), []).includes(currentPage);
  return [
    { id: "library", icon: "library", label: "Biblioteca", run: () => $("homeBtn").click() },
    { id: "notes", icon: "notebook", label: "Cuaderno", when: hasDoc, run: toggleNotebook },
    { id: "board", icon: "board", label: "Pizarra", when: hasDoc, active: boardOpen(), run: toggleBoard },
    { id: "crop", icon: "crop", label: "Recortar para IA", when: hasPdf, run: () => openCapture() },
    { id: "sticky", icon: "sticky", label: "Nota en la página", when: hasPdf, run: () => setStickyPlacement(true) },
    { id: "bookmark", icon: "bookmark", label: marked ? "Quitar marcador" : "Marcar página", when: hasDoc, active: marked, run: toggleBookmark },
    { id: "read", icon: "volume", label: "Leer en voz alta", when: hasDoc, run: () => $("readAloudBtn").click() },
    { id: "study", icon: "check", label: "Estudiar", when: hasDoc, run: () => openStudy() },
    { id: "reflow", icon: "type", label: reflowMode ? "Ver el PDF" : "Modo lectura", when: hasPdf, active: reflowMode, run: () => setReadingMode(reflowMode ? "pdf" : "reflow") },
    { id: "pdf", icon: "download", label: "PDF anotado", when: hasPdf, run: exportAnnotatedPdf },
    { id: "focus", icon: "maximize", label: "Pantalla completa", when: hasDoc, run: toggleFocusMode },
  ].filter((item) => item.when !== false);
}
function openMobileMore() {
  let sheet = $("mobileMore");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "mobileMore";
    sheet.className = "mobile-more";
    document.body.append(sheet);
    sheet.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mm]");
      if (event.target.closest("[data-mm-close]") || button) closeMobileMore();
      if (button) mobileMoreItems().find((item) => item.id === button.dataset.mm)?.run();
    });
  }
  sheet.innerHTML = `<div class="mm-backdrop" data-mm-close></div><section class="mm-sheet" role="menu" aria-label="Más herramientas"><div class="mm-grip" aria-hidden="true"></div><div class="mm-grid">${mobileMoreItems()
    .map((item) => `<button type="button" role="menuitem" data-mm="${item.id}"${item.active ? ' aria-pressed="true"' : ""}>${iconSvg(item.icon)}<span>${item.label}</span></button>`)
    .join("")}</div></section>`;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  $("mobileMoreBtn")?.setAttribute("aria-expanded", "true");
}
function closeMobileMore() {
  const sheet = $("mobileMore");
  if (!sheet || sheet.hidden) return false;
  sheet.classList.remove("is-open");
  sheet.hidden = true;
  $("mobileMoreBtn")?.setAttribute("aria-expanded", "false");
  return true;
}
function configureMobileMore() {
  const actions = document.querySelector(".toolbar-actions");
  if (!actions || $("mobileMoreBtn")) return;
  const button = document.createElement("button");
  button.id = "mobileMoreBtn";
  button.type = "button";
  button.className = "btn icon mobile-more-btn";
  button.title = "Más herramientas";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  setIcon(button, "more");
  button.onclick = () => ($("mobileMore") && !$("mobileMore").hidden ? closeMobileMore() : openMobileMore());
  actions.append(button);
}
// La barra de estado del móvil toma el color de la cabecera del tema activo.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.querySelector(".toolbar") || document.body).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)") meta.content = color;
  });
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
bindLibrary();
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

// Tocar la página muestra u oculta la interfaz, en cualquier modo (página,
// doble, continuo o lectura). Con el dedo también vale tocar sobre el texto
// (un toque no selecciona); con el ratón, solo fuera del texto, para no
// estorbar al seleccionar.
let paperTap = null;
let viewerScrolledAt = 0;
$("viewer").addEventListener("scroll", () => (viewerScrolledAt = performance.now()), { passive: true });
$("viewer").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || document.body.classList.contains("ink-drawing-mode") || !currentBook) return;
  paperTap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), selection: window.getSelection()?.toString() || "" };
});
$("viewer").addEventListener("pointercancel", () => { paperTap = null; });
$("viewer").addEventListener("pointerup", (event) => {
  if (!paperTap || paperTap.id !== event.pointerId) return;
  const tap = paperTap;
  paperTap = null;
  const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
  const touch = event.pointerType !== "mouse";
  if (moved > (touch ? 12 : 8) || performance.now() - tap.time > 600 || markerMode || eraserMode || stickyPlacement) return;
  if (document.body.classList.contains("ink-drawing-mode") || $("captureOverlay").classList.contains("show")) return;
  if (event.target.closest("a, button, input, textarea, select, label, .sticky-pin, .hover-preview, .annotation-actions")) return;
  if (!touch && event.target.closest(".textLayer span, #reflowReader p, #reflowReader li, #reflowReader h2, #reflowReader h3")) return;
  if (!event.target.closest("#canvasWrap, #facingWrap, #continuousView, #reflowReader, #viewer")) return;
  // Un toque que cierra una selección no alterna la interfaz.
  if (tap.selection.trim()) return;
  // Ni el que detiene un desplazamiento con inercia: en el móvil se tocaba
  // para frenar el scroll y la cabecera desaparecía sin querer.
  if (touch && viewerScrolledAt > tap.time - 250) return;
  setTimeout(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    if (touch && !presentationMode && previewCitationAtTap(event.target, event.clientX, event.clientY)) return;
    if (presentationMode) {
      // En presentación, el toque avanza (mitad derecha) o retrocede (izquierda).
      const rect = $("viewer").getBoundingClientRect();
      stepPage(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
      return;
    }
    setReaderChromeHidden(!document.body.classList.contains("reader-chrome-hidden"));
  }, touch ? 60 : 0);
});
// Salida siempre visible del modo inmersivo: en móviles no hay tecla Esc y
// en iPhone no existe la pantalla completa del navegador.
function exitImmersive() {
  if (presentationMode) return exitPresentation();
  if (fullscreenElement() || document.body.classList.contains("focus-mode")) return toggleFocusMode();
  setReaderChromeHidden(false);
}
(() => {
  const button = document.createElement("button");
  button.id = "immersiveExit";
  button.className = "immersive-exit";
  button.type = "button";
  button.title = "Mostrar los controles (Esc)";
  button.setAttribute("aria-label", "Salir del modo inmersivo y mostrar los controles");
  button.innerHTML = iconSvg("minimize");
  button.onclick = exitImmersive;
  document.body.append(button);
})();
$("pageJump").onchange = (e) => {
  const page = Number(e.target.value);
  if (Number.isInteger(page) && pdfDoc) jumpToPage(page);
  else if (pdfDoc) e.target.value = currentPage;
};
$("pageScrubber").oninput = (e) => scheduleScrubPage(Number(e.target.value));
$("viewer").addEventListener("scroll", onContinuousScroll, { passive: true });
$("viewer").addEventListener("scroll", onReflowScroll, { passive: true });
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
$("exportAnnotatedPdf").onclick = exportAnnotatedPdf;
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
      kv.setItem("paper.reader-margin", margin);
      document
        .querySelectorAll("[data-reader-margin]")
        .forEach((item) => item.classList.toggle("active", item === button));
    }),
);
// Posición de lectura dentro del modo lectura: página y fracción recorrida de
// esa página, para conservarla al cambiar tamaño, fuente o ancho.
function reflowReadingAnchor() {
  if (!reflowMode || reflowBuiltFor !== currentBook?.id) return null;
  const viewer = $("viewer");
  const section = $("reflowReader").querySelector(`.reflow-page[data-page="${currentPage}"]`);
  if (!section) return null;
  return { page: currentPage, ratio: Math.max(0, Math.min(1, (viewer.scrollTop - section.offsetTop) / Math.max(1, section.offsetHeight))) };
}
function restoreReflowAnchor(anchor) {
  if (!anchor) return;
  const section = $("reflowReader").querySelector(`.reflow-page[data-page="${anchor.page}"]`);
  if (section) $("viewer").scrollTop = section.offsetTop + anchor.ratio * section.offsetHeight;
}
function applyReflowPreferences() {
  const anchor = reflowReadingAnchor();
  const reader = $("reflowReader");
  const size = Number(kv.getItem("paper.reflow-size") || 20);
  const spacing = kv.getItem("paper.reflow-spacing") || "normal";
  const font = kv.getItem("paper.reflow-font") || "sans";
  const columns = kv.getItem("paper.reflow-columns") || "auto";
  const width = kv.getItem("paper.reflow-width") || "normal";
  const tracking = kv.getItem("paper.reflow-tracking") || "normal";
  const alignment = kv.getItem("paper.reflow-alignment") || "left";
  const theme = kv.getItem("paper.reflow-theme") || "paper";
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
  if (anchor) requestAnimationFrame(() => restoreReflowAnchor(anchor));
}
async function setReadingMode(mode) {
  reflowMode = mode === "reflow";
  if (reflowMode && viewMode !== "single") {
    // La lectura maquetada usa el motor de página única.
    if (viewMode === "continuous") teardownContinuous();
    viewMode = "single";
    kv.setItem("paper.view-mode", "single");
    document.querySelectorAll("[data-view-mode]").forEach((button) =>
      button.classList.toggle("active", button.dataset.viewMode === "single"),
    );
    $("viewer").classList.remove("double-mode");
    $("continuousView").hidden = true;
    $("facingWrap").hidden = true;
  }
  kv.setItem("paper.reading-mode", mode);
  document.body.classList.toggle("reflow-mode", reflowMode);
  if (!reflowMode) teardownReflowDocument();
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
  $("reflowFont").onchange = (event) => { kv.setItem("paper.reflow-font", event.target.value); applyReflowPreferences(); };
  $("reflowSize").oninput = (event) => { kv.setItem("paper.reflow-size", event.target.value); applyReflowPreferences(); };
  document.querySelectorAll("[data-reflow-spacing]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-spacing", button.dataset.reflowSpacing); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-columns]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-columns", button.dataset.reflowColumns); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-width]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-width", button.dataset.reflowWidth); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-tracking]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-tracking", button.dataset.reflowTracking); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-alignment]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-alignment", button.dataset.reflowAlignment); applyReflowPreferences(); }));
  document.querySelectorAll("[data-reflow-theme]").forEach((button) => (button.onclick = () => { kv.setItem("paper.reflow-theme", button.dataset.reflowTheme); applyReflowPreferences(); }));
  $("reflowReset").onclick = () => {
    ["size", "spacing", "font", "columns", "width", "tracking", "alignment", "theme"].forEach((name) => kv.removeItem(`paper.reflow-${name}`));
    applyReflowPreferences();
    toast("Preferencias de lectura restablecidas");
  };
}
function pageColorStorageKey() {
  return currentBook ? key(currentBook.id, `page-color-${currentPage}`) : "paper.page-color";
}
function updatePageColor() {
  pageColor = kv.getItem(pageColorStorageKey()) || "paper";
  const wrap = $("canvasWrap");
  wrap.classList.remove("page-color-warm", "page-color-sepia", "page-color-gray", "page-color-night");
  if (pageColor !== "paper") wrap.classList.add(`page-color-${pageColor}`);
  document.querySelectorAll("[data-page-color]").forEach((button) => button.classList.toggle("active", button.dataset.pageColor === pageColor));
}
function setPageColor(color) {
  pageColor = color;
  kv.setItem(pageColorStorageKey(), color);
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
// Con el pie contraído queda una pastilla con la página actual.
function updateFooterMini() {
  const label = document.querySelector("#footerCollapse .footer-mini-page");
  if (label) label.textContent = pdfDoc ? `${currentPage} / ${pdfDoc.numPages}` : "";
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
    document.body.classList.toggle("footer-is-minimized", minimized);
    kv.setItem("paper.footer-minimized", String(minimized));
    setIcon(collapse, minimized ? "chevronUp" : "chevronDown");
    collapse.insertAdjacentHTML("afterbegin", '<span class="footer-mini-page"></span>');
    updateFooterMini();
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
  setMinimized(kv.getItem("paper.footer-minimized") === "true");
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
$("captureBtn").onclick = () => toggleAssistant();
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
function setUiScale(value) {
  const n = Math.max(0.85, Math.min(1.25, value));
  document.documentElement.style.setProperty("--ui-scale", n);
  kv.setItem("paper.ui-scale", n);
}
$("uiSmaller").onclick = () =>
  setUiScale(Number(kv.getItem("paper.ui-scale") || 1) - 0.05);
$("uiLarger").onclick = () =>
  setUiScale(Number(kv.getItem("paper.ui-scale") || 1) + 0.05);
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
  if (e.key === "Escape" && closeMobileMore()) return;
  if (e.key === "Escape" && $("promptMenu") && !$("promptMenu").hidden) {
    closePromptMenu();
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
  if (!$("palette").hidden || !$("shortcutsPanel").hidden || !$("studyPanel").hidden || !$("dataPanel").hidden) {
    if (e.key === "Escape") {
      closePalette();
      closeShortcuts();
      if (!$("studyPanel").hidden) closeStudy();
    }
    return;
  }
  if (e.target.matches?.("input,select,textarea") || e.target.isContentEditable) return;
  if (boardOpen() && board.focused && !$("boardPane").hidden) {
    if (commandKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      undoBoard(e.shiftKey || e.key.toLowerCase() === "y");
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && deleteBoardSelection()) {
      e.preventDefault();
      return;
    }
  }
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
  if ((e.key === "d" || e.key === "D") && pdfDoc) {
    e.preventDefault();
    toggleSplitView();
  }
  if ((e.key === "w" || e.key === "W") && currentBook) {
    e.preventDefault();
    toggleBoard();
  }
  if ((e.key === "x" || e.key === "X") && pdfDoc) {
    e.preventDefault();
    openCapture();
  }
  if ((e.key === "i" || e.key === "I") && currentBook) {
    e.preventDefault();
    toggleAssistant();
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
// Gestos táctiles: pellizco para el zoom (en cualquier modo de página) y
// deslizar en horizontal para pasar página, solo en página única o doble y
// cuando el gesto es claramente horizontal y la página no se puede desplazar
// de lado (si no, deslizar sirve para moverse por una página ampliada).
let swipeStart = null;
function pinchTarget() {
  return viewMode === "continuous" ? $("continuousView") : $("canvasWrap");
}
function resetPinchPreview() {
  for (const element of [$("canvasWrap"), $("continuousView")]) {
    element.style.transform = "";
    element.style.transformOrigin = "";
    element.classList.remove("pinch-preview");
  }
  document.body.classList.remove("pdf-pinching");
}
document.addEventListener(
  "touchstart",
  (e) => {
    markReadingActivity();
    if (e.touches.length === 2 && pdfDoc && !reflowMode && e.target.closest("#viewer")) {
      e.preventDefault();
      const midpoint = touchMidpoint(e.touches);
      const target = pinchTarget();
      pinchGesture = {
        distance: Math.max(1, touchDistance(e.touches)),
        startScale: scale,
        nextScale: scale,
        anchor: viewMode === "continuous" ? null : zoomAnchor(midpoint.x, midpoint.y),
        target,
      };
      swipeStart = null;
      const rect = target.getBoundingClientRect();
      target.style.transformOrigin = `${midpoint.x - rect.left}px ${midpoint.y - rect.top}px`;
      target.classList.add("pinch-preview");
      document.body.classList.add("pdf-pinching");
      return;
    }
    const touch = e.touches[0];
    swipeStart =
      e.touches.length === 1 && e.target.closest("#viewer") && !document.body.classList.contains("ink-drawing-mode")
        ? { x: touch.clientX, y: touch.clientY, time: performance.now(), scrollLeft: $("viewer").scrollLeft }
        : null;
  },
  { passive: false },
);
document.addEventListener("touchmove", (e) => {
  if (!pinchGesture || e.touches.length < 2) return;
  e.preventDefault();
  const ratio = touchDistance(e.touches) / pinchGesture.distance;
  pinchGesture.nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchGesture.startScale * ratio));
  pinchGesture.target.style.transform = `scale(${pinchGesture.nextScale / pinchGesture.startScale})`;
  $("zoomLabel").textContent = `${Math.round(pinchGesture.nextScale * 100)}%`;
}, { passive: false });
document.addEventListener(
  "touchend",
  (e) => {
    if (pinchGesture && e.touches.length < 2) {
      e.preventDefault();
      const gesture = pinchGesture;
      pinchGesture = null;
      resetPinchPreview();
      swipeStart = null;
      setZoom(gesture.nextScale, gesture.anchor);
      return;
    }
    const start = swipeStart;
    swipeStart = null;
    if (!start || !pdfDoc || reflowMode || viewMode === "continuous") return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x,
      dy = touch.clientY - start.y;
    const viewer = $("viewer");
    const canPanSideways = viewer.scrollWidth > viewer.clientWidth + 4;
    const pannedSideways = Math.abs(viewer.scrollLeft - start.scrollLeft) > 2;
    const selection = window.getSelection();
    if (Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 2 || performance.now() - start.time > 900) return;
    if (canPanSideways || pannedSideways) return;
    if (selection && !selection.isCollapsed) return;
    stepPage(dx < 0 ? 1 : -1);
  },
  { passive: false },
);
document.addEventListener("touchcancel", () => {
  pinchGesture = null;
  swipeStart = null;
  resetPinchPreview();
});
let resizeTimer = null;
let lastViewportSize = { width: window.innerWidth, height: window.innerHeight };
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = window.innerWidth,
      height = window.innerHeight;
    const widthChanged = Math.abs(width - lastViewportSize.width) > 1;
    const heightChanged = Math.abs(height - lastViewportSize.height) > 140;
    lastViewportSize = { width, height };
    if (widthChanged || heightChanged) refitZoom();
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
window.addEventListener("pagehide", () => {
  flushReadingSession(true);
  kv.flush().catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") kv.flush().catch(() => {});
});
readingStatsRefreshTimer = setInterval(() => flushReadingSession(false), 15_000);

(async function init() {
  if (kv.getItem("paper.design-version") !== "4") {
    kv.setItem("paper.design-version", "4");
    kv.setItem("paper.theme", "light");
  }
  document.documentElement.classList.add("ui4");
  applyInterfaceIcons();
  bindInterfaceV4();
  buildReflowControls();
  buildPageColorControls();
  buildThemeChoices();
  updateFocusButton();
  buildInkPalette();
  bindAssistant();
  bindDataPanel();
  bindHoverPreviews();
  bindReferencesPanel();
  bindSplitView();
  bindBoard();
  configureFooterIsland();
  configureMobileMore();
  configureResponsiveUi();
  setTheme(kv.getItem("paper.theme") || "light");
  setUiScale(Number(kv.getItem("paper.ui-scale") || 1));
  document.querySelector('[data-color="yellow"]').classList.add("active");
  setInkTool("highlight");
  await setReadingMode(kv.getItem("paper.reading-mode") || "pdf");
  const margin = kv.getItem("paper.reader-margin") || "normal";
  $("viewer").classList.toggle("margin-compact", margin === "compact");
  $("viewer").classList.toggle("margin-wide", margin === "wide");
  document
    .querySelector(`[data-reader-margin="${margin}"]`)
    ?.classList.add("active");
  await openDb();
  await migrateLegacyDocumentIds();
  bindLaunchQueue();
  await renderLibrary();
  const books = (await dbAll()).sort((a, b) => b.openedAt - a.openedAt);
  if (books.length) requestPersistentStorage();
  if (books[0]) openStored(books[0].id);
  startBackgroundSync();
  consumeSharedFiles();
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
