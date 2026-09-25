// Pruebas de la lógica pura de almacenamiento: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeItems,
  mergeSet,
  mergeValue,
  mergeSnapshots,
  createBackupBlob,
  readBackupBlob,
  backupKind,
  encryptBackupBlob,
  decryptBackupBlob,
  contentId,
  isContentId,
  deriveKey,
  encryptBytes,
  decryptBytes,
} from "../storage.js";

const note = (id, text, extra = {}) => ({ id, page: 1, type: "highlight", text, createdAt: 1, ...extra });

test("mergeItems: sin base suma ambos lados", () => {
  const merged = mergeItems(undefined, [note("a", "uno")], [note("b", "dos")]);
  assert.deepEqual(merged.map((item) => item.id).sort(), ["a", "b"]);
});

test("mergeItems: un borrado en un lado se respeta si el otro no cambió", () => {
  const base = [note("a", "uno"), note("b", "dos")];
  const local = [note("a", "uno")]; // b borrada aquí
  const remote = [note("a", "uno"), note("b", "dos"), note("c", "tres")];
  const merged = mergeItems(base, local, remote);
  assert.deepEqual(merged.map((item) => item.id).sort(), ["a", "c"]);
});

test("mergeItems: editar gana a borrar", () => {
  const base = [note("a", "uno")];
  const local = [];
  const remote = [note("a", "uno editada", { updatedAt: 5 })];
  assert.equal(mergeItems(base, local, remote)[0].text, "uno editada");
});

test("mergeItems: dos ediciones del mismo elemento → la más reciente", () => {
  const base = [note("a", "uno")];
  const local = [note("a", "local", { updatedAt: 10 })];
  const remote = [note("a", "remota", { updatedAt: 20 })];
  assert.equal(mergeItems(base, local, remote)[0].text, "remota");
});

test("mergeSet: marcadores con borrado propagado", () => {
  assert.deepEqual(mergeSet([1, 2], [1], [1, 2, 7]), [1, 7]);
  assert.deepEqual(mergeSet(undefined, [3], [1]), [1, 3]);
});

test("mergeValue: tres bandas en valores simples", () => {
  assert.equal(mergeValue("paper.x.page", "3", "3", "9", 1, 2), "9"); // solo cambió remoto
  assert.equal(mergeValue("paper.x.page", "3", "5", "3", 1, 2), "5"); // solo cambió local
  assert.equal(mergeValue("paper.x.page", "3", "5", "9", 10, 2), "5"); // ambos → el más reciente
  assert.equal(mergeValue("paper.x.page", "3", null, "3", 10, 2), null); // borrado local se propaga
  assert.equal(mergeValue("paper.x.page", undefined, "5", "9", 10, 2), "5"); // sin base: gana el más reciente
});

test("mergeValue: anotaciones y estadísticas se combinan", () => {
  const merged = JSON.parse(mergeValue("paper.doc.annotations", undefined, JSON.stringify([note("a", "1")]), JSON.stringify([note("b", "2")])));
  assert.equal(merged.length, 2);
  const stats = JSON.parse(mergeValue("paper.doc.reading-stats", undefined, JSON.stringify({ totalMs: 10, pageMs: { 1: 5 } }), JSON.stringify({ totalMs: 30, pageMs: { 1: 2, 2: 9 } })));
  assert.equal(stats.totalMs, 30);
  assert.deepEqual(stats.pageMs, { 1: 5, 2: 9 });
});

test("mergeSnapshots: filtra claves y conserva marcas", () => {
  const base = { "paper.a.page": "1", "paper.theme": "light" };
  const local = { "paper.a.page": { v: "4", t: 10 }, "paper.theme": { v: "light", t: 1 }, "paper.notes-window": { v: "{}", t: 5 } };
  const remote = { "paper.a.page": { v: "1", t: 1 }, "paper.theme": { v: "dark", t: 20 } };
  const merged = mergeSnapshots(base, local, remote, (k) => k !== "paper.notes-window");
  assert.equal(merged["paper.a.page"].v, "4");
  assert.equal(merged["paper.theme"].v, "dark");
  assert.equal(merged["paper.notes-window"], undefined);
});

test("copia de seguridad: ida y vuelta con archivos", async () => {
  const pdf = new Blob(["%PDF-1.4 hola"], { type: "application/pdf" });
  const cover = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const blob = createBackupBlob({ schema: "paper-backup", version: 1, docs: [{ id: "sha256:x", file: 0, cover: 1 }], kv: { "paper.theme": "dark" } }, [pdf, cover]);
  assert.equal(await backupKind(blob), "plain");
  const { manifest, file } = await readBackupBlob(blob);
  assert.equal(manifest.kv["paper.theme"], "dark");
  assert.equal(await file(0).text(), "%PDF-1.4 hola");
  assert.deepEqual([...new Uint8Array(await file(1).arrayBuffer())], [1, 2, 3]);
});

test("copia cifrada: requiere la contraseña correcta", async () => {
  const blob = createBackupBlob({ schema: "paper-backup", version: 1, docs: [], kv: { "paper.a.annotations": "[]" } });
  const encrypted = await encryptBackupBlob(blob, "contraseña larga");
  assert.equal(await backupKind(encrypted), "encrypted");
  await assert.rejects(() => decryptBackupBlob(encrypted, "otra contraseña"), /Contraseña incorrecta/);
  const { manifest } = await readBackupBlob(await decryptBackupBlob(encrypted, "contraseña larga"));
  assert.equal(manifest.kv["paper.a.annotations"], "[]");
});

test("ids por contenido: estables y con formato", async () => {
  const a = await contentId(new TextEncoder().encode("mismo contenido"));
  const b = await contentId(new TextEncoder().encode("mismo contenido"));
  assert.equal(a, b);
  assert.ok(isContentId(a));
  assert.ok(!isContentId("informe.pdf:1234:5678"));
});

test("cifrado de bytes: ida y vuelta", async () => {
  const key = await deriveKey("secreto", new Uint8Array(16), 1000);
  const data = new TextEncoder().encode("datos privados");
  const encrypted = await encryptBytes(key, data);
  assert.equal(new TextDecoder().decode(await decryptBytes(key, encrypted)), "datos privados");
});
