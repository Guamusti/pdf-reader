// ---- Almacenamiento local de Paper Reader ----
// Todo lo que la aplicación guarda vive en IndexedDB:
//   pdfs  → documentos (Blob) y metadatos de la biblioteca
//   kv    → anotaciones, notas, tarjetas, progreso y preferencias: { v, t }
//           (v = texto guardado o null si se borró; t = momento del cambio)
//   texts → texto extraído de cada página (índice de búsqueda)
//   meta  → estado interno (sincronización, claves de cifrado)
// localStorage solo se usa como reserva si IndexedDB no está disponible, y los
// datos que hubiera en él de versiones anteriores se trasladan una única vez.

export const DB_NAME = "paper-reader-db";
const DB_VERSION = 2;

export function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function idbDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException("Transacción cancelada", "AbortError"));
  });
}
export function openDatabase({ onBlocked } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pdfs")) db.createObjectStore("pdfs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("texts")) db.createObjectStore("texts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    // Otra pestaña con una versión anterior abierta impide actualizar la base.
    request.onblocked = () => onBlocked?.();
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

// ---- Almacén clave-valor con caché síncrona ----
// La app lee de forma síncrona (como con localStorage) desde una caché en
// memoria que se carga al arrancar; las escrituras se agrupan y se guardan en
// IndexedDB en el siguiente ciclo. Si una escritura falla se reintenta y se
// avisa, en lugar de perder el dato en silencio como ocurría al llenarse
// localStorage. Otras pestañas reciben los cambios por BroadcastChannel.
export class KvStore {
  constructor() {
    this.db = null;
    this.mode = "memory";
    this.cache = new Map();
    this.stamps = new Map();
    this.dirty = new Map();
    this.timer = 0;
    this.flushing = null;
    this.failures = 0;
    this.channel = null;
    this.onError = null;
    this.onRemoteChange = null;
  }
  async open(db) {
    this.db = db;
    try {
      const tx = db.transaction("kv");
      const store = tx.objectStore("kv");
      const [keys, values] = await Promise.all([idbRequest(store.getAllKeys()), idbRequest(store.getAll())]);
      keys.forEach((k, i) => {
        const record = values[i];
        this.stamps.set(k, Number(record?.t) || 0);
        if (record && record.v !== null && record.v !== undefined) this.cache.set(k, String(record.v));
      });
      this.mode = "idb";
    } catch (error) {
      console.warn("IndexedDB no disponible para las notas; se usa localStorage", error);
      this.mode = "local";
      return 0;
    }
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel("paper-kv");
      this.channel.onmessage = (event) => this.receive(event.data);
    }
    return this.migrateLocalStorage();
  }
  // Traslada los datos de versiones anteriores (localStorage) a IndexedDB y,
  // solo cuando la escritura se ha completado, libera localStorage.
  async migrateLocalStorage() {
    let ls;
    try {
      ls = globalThis.localStorage;
      if (!ls) return 0;
    } catch {
      return 0;
    }
    const legacy = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith("paper.")) legacy.push(k);
    }
    if (!legacy.length) return 0;
    const now = Date.now();
    let moved = 0;
    for (const k of legacy) {
      if (this.stamps.has(k)) continue;
      const v = ls.getItem(k);
      if (v === null) continue;
      this.cache.set(k, v);
      this.stamps.set(k, now);
      this.dirty.set(k, v);
      moved++;
    }
    await this.flush();
    for (const k of legacy) ls.removeItem(k);
    return moved;
  }
  getItem(k) {
    if (this.mode === "local") {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    }
    return this.cache.has(k) ? this.cache.get(k) : null;
  }
  setItem(k, value) {
    const v = String(value);
    if (this.mode === "local") {
      try {
        localStorage.setItem(k, v);
      } catch (error) {
        this.onError?.(error);
      }
      return;
    }
    if (this.cache.get(k) === v) return;
    this.cache.set(k, v);
    this.stamps.set(k, Date.now());
    this.dirty.set(k, v);
    this.schedule();
  }
  removeItem(k) {
    if (this.mode === "local") {
      try {
        localStorage.removeItem(k);
      } catch {}
      return;
    }
    if (!this.cache.has(k)) return;
    this.cache.delete(k);
    this.stamps.set(k, Date.now());
    this.dirty.set(k, null);
    this.schedule();
  }
  keys(prefix = "") {
    if (this.mode === "local") {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(prefix)) out.push(k);
        }
      } catch {}
      return out;
    }
    return [...this.cache.keys()].filter((k) => k.startsWith(prefix));
  }
  // Instantánea completa, incluidas las marcas de borrado (v = null).
  snapshot() {
    const out = {};
    if (this.mode === "local") {
      for (const k of this.keys("paper.")) out[k] = { v: this.getItem(k), t: 0 };
      return out;
    }
    for (const [k, t] of this.stamps) out[k] = { v: this.cache.has(k) ? this.cache.get(k) : null, t };
    for (const [k, v] of this.cache) if (!out[k]) out[k] = { v, t: 0 };
    return out;
  }
  // Aplica valores que vienen de fuera (copia de seguridad o sincronización)
  // conservando su marca de tiempo.
  applyEntries(entries) {
    const changed = [];
    for (const [k, v, t] of entries) {
      if (this.mode === "local") {
        v === null ? this.removeItem(k) : this.setItem(k, v);
        changed.push(k);
        continue;
      }
      const current = this.cache.has(k) ? this.cache.get(k) : null;
      if (current === v) continue;
      if (v === null) this.cache.delete(k);
      else this.cache.set(k, String(v));
      this.stamps.set(k, Number(t) || Date.now());
      this.dirty.set(k, v === null ? null : String(v));
      changed.push(k);
    }
    if (changed.length) this.schedule();
    return changed;
  }
  schedule() {
    if (this.mode !== "idb" || this.timer) return;
    this.timer = setTimeout(() => this.flush().catch(() => {}), 40);
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.mode !== "idb") return;
    if (this.flushing) await this.flushing.catch(() => {});
    if (!this.dirty.size) return;
    const batch = [...this.dirty];
    this.dirty.clear();
    const run = (async () => {
      const tx = this.db.transaction("kv", "readwrite");
      const store = tx.objectStore("kv");
      for (const [k, v] of batch) store.put({ v, t: this.stamps.get(k) || Date.now() }, k);
      await idbDone(tx);
    })();
    this.flushing = run;
    try {
      await run;
      this.failures = 0;
      try {
        this.channel?.postMessage(batch.map(([k, v]) => [k, v, this.stamps.get(k) || 0]));
      } catch {}
    } catch (error) {
      // Se conserva lo pendiente (salvo que haya un valor aún más nuevo).
      for (const [k, v] of batch) if (!this.dirty.has(k)) this.dirty.set(k, v);
      this.failures++;
      this.onError?.(error);
      if (this.failures < 6) this.timer = setTimeout(() => this.flush().catch(() => {}), 1200 * this.failures);
      throw error;
    } finally {
      if (this.flushing === run) this.flushing = null;
    }
  }
  receive(entries) {
    if (!Array.isArray(entries)) return;
    const changed = [];
    for (const [k, v, t] of entries) {
      if (this.dirty.has(k) || (this.stamps.get(k) || 0) > t) continue;
      if (v === null) this.cache.delete(k);
      else this.cache.set(k, v);
      this.stamps.set(k, t);
      changed.push(k);
    }
    if (changed.length) this.onRemoteChange?.(changed);
  }
}

// ---- Identificador de documento por contenido ----
// El mismo PDF recibe siempre el mismo id aunque se renombre o se vuelva a
// descargar, así que sus anotaciones le siguen.
export async function sha256Hex(data) {
  const buffer = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function contentId(buffer) {
  return `sha256:${await sha256Hex(buffer)}`;
}
export function isContentId(id) {
  return /^sha256:[0-9a-f]{64}$/.test(String(id));
}

// ---- Cifrado (AES-GCM con clave derivada de una contraseña) ----
const PBKDF2_ITERATIONS = 310_000;
export function toBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}
export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
// Formato: 12 bytes de IV seguidos del texto cifrado.
export async function encryptBytes(key, data) {
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), 12);
  return out;
}
export async function decryptBytes(key, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
}

// ---- Copia de seguridad en un único archivo ----
// Estructura: una línea de cabecera, la longitud del manifiesto, el manifiesto
// JSON y, a continuación, los archivos (PDFs, portadas) uno detrás de otro. Se
// compone como Blob, sin copiar los PDFs en memoria.
const BACKUP_MAGIC = "PAPER-BACKUP/1\n";
const BACKUP_MAGIC_ENC = "PAPER-BACKUP-ENC/1\n";
export function createBackupBlob(manifest, files = []) {
  let offset = 0;
  const entries = files.map((blob) => {
    const entry = { offset, size: blob.size, type: blob.type || "application/octet-stream" };
    offset += blob.size;
    return entry;
  });
  const json = new TextEncoder().encode(JSON.stringify({ ...manifest, files: entries }));
  return new Blob([BACKUP_MAGIC, `${json.length}\n`, json, ...files], { type: "application/x-paper-backup" });
}
async function readHeader(blob, magic) {
  const head = new Uint8Array(await blob.slice(0, magic.length + 24).arrayBuffer());
  const text = new TextDecoder().decode(head);
  if (!text.startsWith(magic)) return null;
  const end = text.indexOf("\n", magic.length);
  const length = Number(text.slice(magic.length, end));
  if (end < 0 || !Number.isFinite(length) || length <= 0) throw new Error("Cabecera de copia dañada");
  // La cabecera es ASCII: posición en texto = posición en bytes.
  return { start: end + 1, length };
}
export async function backupKind(blob) {
  if (await readHeader(blob, BACKUP_MAGIC_ENC).catch(() => null)) return "encrypted";
  if (await readHeader(blob, BACKUP_MAGIC).catch(() => null)) return "plain";
  return "unknown";
}
export async function readBackupBlob(blob) {
  const header = await readHeader(blob, BACKUP_MAGIC);
  if (!header) throw new Error("No es una copia de Paper Reader");
  const manifest = JSON.parse(await blob.slice(header.start, header.start + header.length).text());
  if (manifest?.schema !== "paper-backup") throw new Error("Copia no compatible");
  const dataStart = header.start + header.length;
  const file = (index) => {
    const entry = manifest.files?.[index];
    if (!entry) return null;
    return blob.slice(dataStart + entry.offset, dataStart + entry.offset + entry.size, entry.type);
  };
  return { manifest, file };
}
export async function encryptBackupBlob(blob, passphrase) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const data = await encryptBytes(key, await blob.arrayBuffer());
  const header = new TextEncoder().encode(JSON.stringify({ salt: toBase64(salt), iterations: PBKDF2_ITERATIONS }));
  return new Blob([BACKUP_MAGIC_ENC, `${header.length}\n`, header, data], { type: "application/x-paper-backup" });
}
export async function decryptBackupBlob(blob, passphrase) {
  const header = await readHeader(blob, BACKUP_MAGIC_ENC);
  if (!header) throw new Error("La copia no está cifrada");
  const info = JSON.parse(await blob.slice(header.start, header.start + header.length).text());
  const key = await deriveKey(passphrase, fromBase64(info.salt), info.iterations);
  try {
    const plain = await decryptBytes(key, await blob.slice(header.start + header.length).arrayBuffer());
    return new Blob([plain]);
  } catch {
    throw new Error("Contraseña incorrecta");
  }
}

// ---- Fusión de datos ----
// Combina un valor local y otro remoto. Con `base` (el último estado común)
// la fusión es a tres bandas: se sabe qué lado cambió y los borrados se
// propagan. Sin base (restaurar una copia) se hace la unión de ambos lados.
const ITEM_ARRAY_KEY = /\.(annotations|cards)$/;
const SET_ARRAY_KEY = /\.bookmarks$/;
const STATS_KEY = /\.reading-stats$/;
function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function itemStamp(item) {
  return Math.max(Number(item?.updatedAt) || 0, Number(item?.reviewedAt) || 0, Number(item?.createdAt) || 0);
}
export function mergeItems(base, local, remote) {
  const index = (list) => new Map((Array.isArray(list) ? list : []).filter((item) => item && item.id !== undefined && item.id !== null).map((item) => [String(item.id), item]));
  const B = index(base), L = index(local), R = index(remote);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id), r = R.get(id), b = B.get(id);
    if (l && r) {
      if (same(l, r) || (b && same(r, b))) out.push(l);
      else if (b && same(l, b)) out.push(r);
      else out.push(itemStamp(r) > itemStamp(l) ? r : l);
    } else if (l) {
      if (!(b && same(b, l))) out.push(l);
    } else if (r) {
      if (!(b && same(b, r))) out.push(r);
    }
  }
  return out;
}
export function mergeSet(base, local, remote) {
  const B = new Set(Array.isArray(base) ? base : []);
  const L = new Set(Array.isArray(local) ? local : []);
  const R = new Set(Array.isArray(remote) ? remote : []);
  return [...new Set([...L, ...R])].filter((value) => !(B.has(value) && (!L.has(value) || !R.has(value)))).sort((a, b) => a - b);
}
export function mergeStats(local, remote) {
  const a = local || {}, b = remote || {};
  const maxMap = (x = {}, y = {}) => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = Math.max(Number(out[k]) || 0, Number(v) || 0);
    return out;
  };
  return {
    ...a,
    ...b,
    totalMs: Math.max(Number(a.totalMs) || 0, Number(b.totalMs) || 0),
    sessions: Math.max(Number(a.sessions) || 0, Number(b.sessions) || 0),
    lastReadAt: Math.max(Number(a.lastReadAt) || 0, Number(b.lastReadAt) || 0),
    pageMs: maxMap(a.pageMs, b.pageMs),
    pageChars: maxMap(a.pageChars, b.pageChars),
  };
}
// `base` undefined = sin estado común; null = la clave no existía.
export function mergeValue(key, base, local, remote, localT = 0, remoteT = 0) {
  if (local === remote) return local;
  if (base !== undefined) {
    if (local === base) return remote;
    if (remote === base) return local;
  }
  if (ITEM_ARRAY_KEY.test(key)) return JSON.stringify(mergeItems(parseJson(base, []), parseJson(local, []), parseJson(remote, [])));
  if (SET_ARRAY_KEY.test(key)) return JSON.stringify(mergeSet(parseJson(base, []), parseJson(local, []), parseJson(remote, [])));
  if (STATS_KEY.test(key) && local !== null && remote !== null) return JSON.stringify(mergeStats(parseJson(local, {}), parseJson(remote, {})));
  // Un cambio gana a un borrado; entre dos cambios, el más reciente.
  if (local === null || local === undefined) return remote;
  if (remote === null || remote === undefined) return local;
  return Number(remoteT) > Number(localT) ? remote : local;
}
// Fusiona dos instantáneas { clave: { v, t } }. Devuelve el estado fusionado.
export function mergeSnapshots(base, local, remote, filter = () => true) {
  const merged = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const k of keys) {
    if (!filter(k)) continue;
    const l = local?.[k], r = remote?.[k];
    const baseValue = base ? (k in base ? base[k] : null) : undefined;
    const v = mergeValue(k, baseValue, l?.v ?? null, r?.v ?? null, l?.t || 0, r?.t || 0);
    const t = v === (l?.v ?? null) ? l?.t || r?.t || Date.now() : v === (r?.v ?? null) ? r?.t || Date.now() : Date.now();
    merged[k] = { v, t };
  }
  return merged;
}
