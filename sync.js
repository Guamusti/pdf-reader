// ---- Sincronización por carpeta ----
// Paper Reader no tiene servidor: se sincroniza a través de una carpeta que el
// usuario ya sincroniza con su nube (Dropbox, Google Drive, OneDrive, iCloud…).
// Estructura dentro de la carpeta «Paper Reader»:
//   paper-sync.json     → versión y, si está cifrada, sal y comprobación
//   state.json|.bin     → metadatos de la biblioteca y todas las notas/ajustes
//   docs/<huella>.pdf   → cada documento (".bin" si está cifrado)
// La fusión es a tres bandas con el último estado sincronizado («base»), así
// que los borrados se propagan sin resucitar datos y los cambios simultáneos
// en dos dispositivos se combinan (ver mergeSnapshots en storage.js).
import {
  deriveKey,
  encryptBytes,
  decryptBytes,
  toBase64,
  fromBase64,
  randomBytes,
  sha256Hex,
  isContentId,
  mergeSnapshots,
} from "./storage.js?v=1";

const FOLDER = "Paper Reader";
const CHECK_TEXT = "paper-sync-ok";

async function readFile(dir, name) {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    if (error?.name === "NotFoundError" || error?.name === "TypeMismatchError") return null;
    throw error;
  }
}
async function writeFile(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
}
async function removeFile(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

export function folderSyncSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// Abre (o crea) la carpeta de sincronización dentro de `root`. Si la carpeta
// ya existe y está cifrada, hace falta la contraseña; si es nueva, se cifra
// cuando se proporciona una.
export async function openSyncFolder(root, passphrase = "") {
  const dir = await root.getDirectoryHandle(FOLDER, { create: true });
  const infoFile = await readFile(dir, "paper-sync.json");
  if (infoFile) {
    const info = JSON.parse(await infoFile.text());
    if (info?.schema !== "paper-sync") throw new Error("La carpeta contiene datos que no son de Paper Reader");
    if (!info.encryption) return { dir, key: null, encrypted: false, created: false };
    if (!passphrase) {
      const error = new Error("Esta carpeta está cifrada: escribe la contraseña de sincronización");
      error.code = "needs-passphrase";
      throw error;
    }
    const key = await deriveKey(passphrase, fromBase64(info.encryption.salt), info.encryption.iterations);
    try {
      const check = new TextDecoder().decode(await decryptBytes(key, fromBase64(info.encryption.check)));
      if (check !== CHECK_TEXT) throw new Error();
    } catch {
      const error = new Error("Contraseña de sincronización incorrecta");
      error.code = "bad-passphrase";
      throw error;
    }
    return { dir, key, encrypted: true, created: false };
  }
  let key = null,
    encryption = null;
  if (passphrase) {
    const salt = randomBytes(16);
    const iterations = 310_000;
    key = await deriveKey(passphrase, salt, iterations);
    encryption = { salt: toBase64(salt), iterations, check: toBase64(await encryptBytes(key, new TextEncoder().encode(CHECK_TEXT))) };
  }
  await writeFile(dir, "paper-sync.json", JSON.stringify({ schema: "paper-sync", version: 1, createdAt: new Date().toISOString(), encryption }, null, 2));
  return { dir, key, encrypted: Boolean(key), created: true };
}

async function readState(dir, key) {
  const file = await readFile(dir, key ? "state.bin" : "state.json");
  if (!file) return null;
  const bytes = key ? await decryptBytes(key, await file.arrayBuffer()) : new Uint8Array(await file.arrayBuffer());
  const state = JSON.parse(new TextDecoder().decode(bytes));
  return state?.schema === "paper-sync-state" ? state : null;
}
async function writeState(dir, key, state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  if (key) await writeFile(dir, "state.bin", await encryptBytes(key, bytes));
  else await writeFile(dir, "state.json", bytes);
}
async function docFileName(doc, encrypted) {
  const stem = isContentId(doc.id) ? doc.id.slice(7) : `x-${await sha256Hex(doc.id)}`;
  return `${stem}.${encrypted ? "bin" : doc.kind === "markdown" ? "md" : "pdf"}`;
}
function docMeta(doc) {
  const { id, name, kind, pages, addedAt, openedAt, size } = doc;
  return { id, name, kind: kind || "pdf", pages: pages || null, addedAt: addedAt || 0, openedAt: openedAt || 0, size: size || 0 };
}

// `adapter` conecta con la app: lista y guarda documentos, lee y aplica las
// notas y conserva la base. Devuelve un resumen de lo que ha cambiado.
export async function syncFolder({ dir, key, adapter, onProgress = () => {} }) {
  const docsDir = await dir.getDirectoryHandle("docs", { create: true });
  onProgress("Leyendo la carpeta…");
  const remoteState = await readState(dir, key);
  // Sin estado remoto (carpeta nueva o vaciada) no se usa la base: nunca se
  // interpreta una carpeta vacía como «bórralo todo».
  const base = remoteState ? await adapter.loadBase() : null;
  const remoteDocs = { ...(remoteState?.docs || {}) };
  const localList = await adapter.listDocs();
  const local = new Map(localList.map((doc) => [doc.id, doc]));
  const baseDocs = new Set(base?.docs || []);
  const uploads = [], downloads = [], deleteLocal = [], deleteRemote = [];
  for (const id of new Set([...local.keys(), ...Object.keys(remoteDocs)])) {
    const l = local.get(id), r = remoteDocs[id];
    if (l && r) {
      // Mismo documento en ambos lados: se conserva la apertura más reciente.
      if ((l.openedAt || 0) > (r.openedAt || 0)) remoteDocs[id] = { ...r, openedAt: l.openedAt, name: l.name, pages: l.pages || r.pages };
      continue;
    }
    if (l) (baseDocs.has(id) ? deleteLocal : uploads).push(l);
    else (baseDocs.has(id) ? deleteRemote : downloads).push(r);
  }
  if (deleteLocal.length && (deleteLocal.length > 3 || deleteLocal.length > localList.length * 0.3)) {
    if (!(await adapter.confirmDeletions(deleteLocal))) {
      uploads.push(...deleteLocal);
      deleteLocal.length = 0;
    }
  }

  const summary = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, missing: 0, notesIn: 0, notesOut: 0 };
  for (const [index, doc] of uploads.entries()) {
    onProgress(`Subiendo ${index + 1}/${uploads.length} · ${doc.name}`);
    const blob = await adapter.readDoc(doc.id);
    if (!blob) continue;
    const name = await docFileName(doc, Boolean(key));
    await writeFile(docsDir, name, key ? await encryptBytes(key, await blob.arrayBuffer()) : blob);
    remoteDocs[doc.id] = { ...docMeta(doc), file: name };
    summary.uploaded++;
  }
  for (const [index, doc] of downloads.entries()) {
    onProgress(`Descargando ${index + 1}/${downloads.length} · ${doc.name}`);
    const file = doc.file ? await readFile(docsDir, doc.file) : null;
    if (!file) {
      // El archivo aún no ha llegado (la nube sigue sincronizando): se
      // intentará en la próxima sincronización.
      summary.missing++;
      continue;
    }
    const bytes = key ? await decryptBytes(key, await file.arrayBuffer()) : new Uint8Array(await file.arrayBuffer());
    await adapter.addDoc(docMeta(doc), new Blob([bytes], { type: doc.kind === "markdown" ? "text/markdown" : "application/pdf" }));
    local.set(doc.id, doc);
    summary.downloaded++;
  }
  for (const doc of deleteRemote) {
    if (doc.file) await removeFile(docsDir, doc.file);
    delete remoteDocs[doc.id];
    summary.deletedRemote++;
  }
  for (const doc of deleteLocal) {
    await adapter.deleteDoc(doc.id);
    local.delete(doc.id);
    summary.deletedLocal++;
  }

  onProgress("Combinando notas…");
  const localSnapshot = adapter.kvSnapshot();
  const merged = mergeSnapshots(base ? base.kv || {} : undefined, localSnapshot, remoteState?.kv || {}, adapter.filterKey);
  const localChanges = [];
  const remoteKv = {};
  for (const [k, entry] of Object.entries(merged)) {
    const current = localSnapshot[k]?.v ?? null;
    if (entry.v !== current) localChanges.push([k, entry.v, entry.t]);
    if (entry.v !== null) remoteKv[k] = entry;
    const before = remoteState?.kv?.[k]?.v ?? null;
    if (entry.v !== before) summary.notesOut++;
  }
  summary.notesIn = localChanges.length;
  if (localChanges.length) await adapter.applyKv(localChanges);

  onProgress("Guardando…");
  await writeState(dir, key, { schema: "paper-sync-state", version: 1, updatedAt: new Date().toISOString(), docs: remoteDocs, kv: remoteKv });
  const baseKv = {};
  for (const [k, entry] of Object.entries(remoteKv)) baseKv[k] = entry.v;
  await adapter.saveBase({ docs: Object.keys(remoteDocs).filter((id) => local.has(id)), kv: baseKv, at: Date.now() });
  return summary;
}
