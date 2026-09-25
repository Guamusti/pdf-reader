// Sincronización entre dos «dispositivos» simulados sobre una carpeta en
// memoria que imita la File System Access API: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSyncFolder, syncFolder } from "../sync.js";

class FakeDir {
  constructor(name = "root") {
    this.name = name;
    this.entries = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.entries.has(name)) {
      if (!create) throw Object.assign(new Error("no existe"), { name: "NotFoundError" });
      this.entries.set(name, new FakeDir(name));
    }
    return this.entries.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.entries.has(name)) {
      if (!create) throw Object.assign(new Error("no existe"), { name: "NotFoundError" });
      this.entries.set(name, { data: new Uint8Array() });
    }
    const entry = this.entries.get(name);
    return {
      getFile: async () => new File([entry.data], name),
      createWritable: async () => {
        const chunks = [];
        return {
          write: async (data) => chunks.push(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data)),
          close: async () => {
            entry.data = new Uint8Array(await new Blob(chunks).arrayBuffer());
          },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name) {
    if (!this.entries.delete(name)) throw Object.assign(new Error("no existe"), { name: "NotFoundError" });
  }
}

// Un dispositivo: documentos en memoria, notas { clave: { v, t } } y base.
function device(name) {
  const docs = new Map();
  const kv = {};
  let base = null;
  let clock = 1000;
  const self = {
    name,
    docs,
    kv,
    set(k, v) {
      kv[k] = { v, t: ++clock + (name === "B" ? 0.5 : 0) };
    },
    get(k) {
      return kv[k]?.v ?? null;
    },
    addDoc(id, text) {
      docs.set(id, { meta: { id, name: `${id}.pdf`, kind: "pdf", addedAt: 1, openedAt: 1 }, blob: new Blob([text]) });
    },
    removeDoc(id) {
      docs.delete(id);
      for (const k of Object.keys(kv)) if (k.startsWith(`paper.${id}.`)) kv[k] = { v: null, t: ++clock };
    },
    adapter: {
      listDocs: async () => [...docs.values()].map((doc) => doc.meta),
      readDoc: async (id) => docs.get(id)?.blob || null,
      addDoc: async (meta, blob) => docs.set(meta.id, { meta, blob }),
      deleteDoc: async (id) => self.removeDoc(id),
      kvSnapshot: () => structuredClone(kv),
      applyKv: async (entries) => {
        for (const [k, v, t] of entries) kv[k] = { v, t };
      },
      loadBase: async () => base,
      saveBase: async (value) => {
        base = value;
      },
      confirmDeletions: async () => true,
      filterKey: (k) => k.startsWith("paper.") && k !== "paper.notes-window",
    },
  };
  return self;
}

const ID = "sha256:" + "a".repeat(64);
const ID2 = "sha256:" + "b".repeat(64);
const anns = (...ids) => JSON.stringify(ids.map((id) => ({ id, page: 1, type: "highlight", text: id, createdAt: 1 })));

async function sync(dev, root, passphrase) {
  const { dir, key } = await openSyncFolder(root, passphrase);
  return syncFolder({ dir, key, adapter: dev.adapter });
}

test("dos dispositivos: subir, recibir, combinar y borrar (cifrado)", async () => {
  const root = new FakeDir();
  const A = device("A"), B = device("B");
  A.addDoc(ID, "%PDF documento uno");
  A.set(`paper.${ID}.annotations`, anns("a1"));
  A.set(`paper.${ID}.bookmarks`, "[2]");
  A.set("paper.notes-window", '{"left":1}'); // propio del dispositivo: no se sincroniza

  const s1 = await sync(A, root, "clave secreta");
  assert.equal(s1.uploaded, 1);
  // Todo cifrado: no hay JSON legible ni PDFs en claro
  const folder = await root.getDirectoryHandle("Paper Reader");
  assert.ok(folder.entries.has("state.bin") && !folder.entries.has("state.json"));
  const stored = [...(await folder.getDirectoryHandle("docs")).entries.values()][0].data;
  assert.ok(!new TextDecoder().decode(stored).includes("documento uno"));

  await assert.rejects(() => sync(B, root, "otra"), /incorrecta/);
  const s2 = await sync(B, root, "clave secreta");
  assert.equal(s2.downloaded, 1);
  assert.equal(await B.docs.get(ID).blob.text(), "%PDF documento uno");
  assert.equal(B.get(`paper.${ID}.annotations`), anns("a1"));
  assert.equal(B.get("paper.notes-window"), null);

  // Cambios simultáneos: B añade una anotación, A quita un marcador.
  B.set(`paper.${ID}.annotations`, anns("a1", "b1"));
  A.set(`paper.${ID}.bookmarks`, "[]");
  await sync(A, root, "clave secreta");
  await sync(B, root, "clave secreta");
  await sync(A, root, "clave secreta");
  assert.deepEqual(JSON.parse(A.get(`paper.${ID}.annotations`)).map((x) => x.id), ["a1", "b1"]);
  assert.equal(B.get(`paper.${ID}.bookmarks`), "[]");

  // Borrar una anotación en A se propaga sin resucitar.
  A.set(`paper.${ID}.annotations`, anns("b1"));
  await sync(A, root, "clave secreta");
  await sync(B, root, "clave secreta");
  assert.deepEqual(JSON.parse(B.get(`paper.${ID}.annotations`)).map((x) => x.id), ["b1"]);

  // Borrar el documento en B lo borra en A (con sus notas).
  B.addDoc(ID2, "%PDF dos");
  await sync(B, root, "clave secreta");
  await sync(A, root, "clave secreta");
  assert.ok(A.docs.has(ID2));
  B.removeDoc(ID);
  const s3 = await sync(B, root, "clave secreta");
  assert.equal(s3.deletedRemote, 1);
  const s4 = await sync(A, root, "clave secreta");
  assert.equal(s4.deletedLocal, 1);
  assert.ok(!A.docs.has(ID));
  assert.equal(A.get(`paper.${ID}.annotations`), null);
  assert.ok(A.docs.has(ID2));
});

test("una carpeta vaciada no borra la biblioteca local", async () => {
  const root = new FakeDir();
  const A = device("A");
  A.addDoc(ID, "%PDF uno");
  await sync(A, root, "");
  // Alguien vacía la carpeta (o se elige otra): no hay estado remoto.
  root.entries.clear();
  const summary = await sync(A, root, "");
  assert.equal(summary.deletedLocal, 0);
  assert.equal(summary.uploaded, 1);
  assert.ok(A.docs.has(ID));
});

test("sin cifrar: el estado es JSON legible", async () => {
  const root = new FakeDir();
  const A = device("A");
  A.set("paper.theme", "dark");
  await sync(A, root, "");
  const folder = await root.getDirectoryHandle("Paper Reader");
  const state = JSON.parse(new TextDecoder().decode(folder.entries.get("state.json").data));
  assert.equal(state.kv["paper.theme"].v, "dark");
});
