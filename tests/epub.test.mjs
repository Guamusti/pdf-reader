// Lector de EPUB: ZIP y rutas internas. node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipDirectory, readZipEntry, resolvePath, resolveHref, chapterAnchor, mediaTypeFor } from "../epub.js";
import { buildZip } from "./e2e/zip-writer.mjs";

test("lee entradas almacenadas y comprimidas de un ZIP", async () => {
  const long = "Capítulo con acentos: ñandú, pingüino. ".repeat(200);
  const zip = readZipDirectory(buildZip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "OEBPS/text/ch1.xhtml", data: long },
  ]));
  assert.deepEqual([...zip.entries.keys()], ["mimetype", "OEBPS/text/ch1.xhtml"]);
  assert.equal(zip.entries.get("OEBPS/text/ch1.xhtml").method, 8);
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, "mimetype")), "application/epub+zip");
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, "OEBPS/text/ch1.xhtml")), long);
  assert.equal(await readZipEntry(zip, "no-existe.xhtml"), null);
  assert.throws(() => readZipDirectory(new TextEncoder().encode("esto no es un zip")), /ZIP/);
});

test("rutas relativas dentro del libro", () => {
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "../images/fig.png"), "OEBPS/images/fig.png");
  assert.equal(resolvePath("OEBPS/content.opf", "text/ch%201.xhtml"), "OEBPS/text/ch 1.xhtml");
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "./ch2.xhtml#nota"), "OEBPS/text/ch2.xhtml");
  assert.equal(resolveHref("OEBPS/text/ch1.xhtml", "ch2.xhtml#n1"), "OEBPS/text/ch2.xhtml#n1");
  assert.equal(resolveHref("OEBPS/text/ch1.xhtml", "#n1"), "OEBPS/text/ch1.xhtml#n1");
  assert.equal(chapterAnchor(3, "nota 1"), "epub-3-nota_1");
  assert.equal(mediaTypeFor("a/b/portada.JPG"), "image/jpeg");
});
