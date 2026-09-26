// Pruebas de extracción de referencias y citas: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLines,
  extractReferences,
  parseReference,
  citationAt,
  findEntryForCitation,
  captionPattern,
  toBibtex,
  toRis,
  findDoi,
  findArxiv,
  metaFromCsl,
} from "../references.js";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8")).map((page) => ({
    page: page.page,
    lines: buildLines(page.items, page.width),
  }));

test("dos columnas: las líneas no mezclan columnas", () => {
  const [first] = load("paper-linked");
  const intro = first.lines.find((line) => line.text.startsWith("Transformers [2]"));
  assert.ok(intro, "la primera línea de la introducción se reconstruye sola");
  assert.ok(!intro.text.includes("document preserves") && intro.text.length < 90);
});

test("bibliografía numerada: 8 entradas con DOI y arXiv", () => {
  const entries = extractReferences(load("paper-linked"));
  assert.equal(entries.length, 8);
  assert.deepEqual(entries.map((entry) => entry.label), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(entries[0].arxiv, "2004.05150");
  assert.equal(entries[0].title, "Longformer: The long-document transformer");
  assert.deepEqual(entries[0].surnames, ["Beltagy", "Peters", "Cohan"]);
  assert.equal(entries[1].doi, "10.5555/3295222.3295349");
  assert.equal(entries[5].doi, "10.1145/3530811");
  assert.equal(entries[6].doi, "10.18653/v1/2020.emnlp-main.19");
  assert.equal(entries[7].year, "2022");
});

test("bibliografía autor-año con sangría francesa", () => {
  const entries = extractReferences(load("paper-authoryear"));
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((entry) => entry.surnames[0]), ["Bahdanau", "Devlin", "Smith", "Vaswani"]);
  assert.equal(entries[1].doi, "10.18653/v1/N19-1423");
  assert.equal(entries[3].title, "Attention is all you need");
  assert.equal(entries[3].year, "2017");
});

test("citas en el texto", () => {
  assert.deepEqual(citationAt("as surveyed in [6]. The", 16).numbers, [6]);
  assert.deepEqual(citationAt("see [2, 4-6] for", 7).numbers, [2, 4, 5, 6]);
  const ay = citationAt("The transformer (Vaswani et al., 2017) removed", 22);
  assert.equal(ay.kind, "author");
  assert.equal(ay.surname, "Vaswani");
  assert.equal(ay.year, "2017");
  assert.equal(citationAt("Smith and Jones (2019) report", 3).surname, "Smith");
  const figure = citationAt("As shown in Figure 1, the local", 15);
  assert.equal(figure.kind, "figure");
  assert.equal(figure.number, "1");
  assert.equal(citationAt("Results are summarised in Table 1.", 28).kind, "table");
  assert.equal(citationAt("nothing to see here", 5), null);
});

test("citas casadas con su entrada", () => {
  const numbered = extractReferences(load("paper-linked"));
  assert.equal(findEntryForCitation(numbered, citationAt("[6]"))[0].doi, "10.1145/3530811");
  const authorYear = extractReferences(load("paper-authoryear"));
  const [hit] = findEntryForCitation(authorYear, citationAt("(Devlin et al., 2019)"));
  assert.equal(hit.surnames[0], "Devlin");
});

test("pies de figura y tabla", () => {
  assert.ok(captionPattern("figure", "1").test("Figure 1: Attention patterns"));
  assert.ok(captionPattern("figure", "2").test("Fig. 2. Reading speed"));
  assert.ok(!captionPattern("figure", "1").test("As shown in Figure 1, the"));
  assert.ok(captionPattern("table", "1").test("Table 1: Accuracy"));
});

test("identificadores y exportación", () => {
  assert.equal(findDoi("DOI: 10.48550/arXiv.2004.05150"), "10.48550/arXiv.2004.05150");
  assert.equal(findArxiv("DOI: 10.48550/arXiv.2004.05150"), "2004.05150");
  const meta = parseReference("A. Vaswani, N. Shazeer, and N. Parmar. Attention is all you need. In NeurIPS, 2017. doi:10.5555/3295222.3295349");
  const bib = toBibtex(meta);
  assert.match(bib, /^@misc\{vaswani2017attention,/);
  assert.match(bib, /author = \{A\. Vaswani and N\. Shazeer and N\. Parmar\}/);
  assert.match(bib, /title = \{\{Attention is all you need\}\}/);
  assert.match(bib, /doi = \{10\.5555\/3295222\.3295349\}/);
  const ris = toRis(meta);
  assert.match(ris, /^TY {2}- GEN/);
  assert.match(ris, /DO {2}- 10\.5555\/3295222\.3295349/);
  assert.match(ris, /ER {2}- $/);
  const authorYear = parseReference("Bahdanau, D., Cho, K., and Bengio, Y. (2015). Neural machine translation by jointly learning to align and translate. In ICLR.");
  assert.match(toBibtex(authorYear), /author = \{Bahdanau, D\. and Cho, K\. and Bengio, Y\.\}/);
  assert.match(toRis(authorYear), /AU {2}- Bahdanau, D\.\nAU {2}- Cho, K\.\nAU {2}- Bengio, Y\./);
  const csl = metaFromCsl({ title: "Longformer", author: [{ family: "Beltagy", given: "Iz" }], issued: { "date-parts": [[2020]] }, DOI: "10.48550/arXiv.2004.05150", "container-title": "arXiv" });
  assert.match(toBibtex(csl), /author = \{Beltagy, Iz\}/);
});

test("referencias internas: ecuaciones, enunciados y secciones", async () => {
  const { anchorScore, anchorProbe } = await import("../references.js");
  assert.deepEqual(
    ["by (6.1) we get", "as in Eq. (3) above", "see Theorem 2.3 and", "by Thm. 4.1b,", "el Lema 3 dice", "in Section 3.2 we", "§4 shows"].map((text) => {
      const hit = citationAt(text, text.search(/\d/));
      return [hit.kind, hit.number, hit.word || ""];
    }),
    [["equation", "6.1", ""], ["equation", "3", ""], ["statement", "2.3", "theorem"], ["statement", "4.1b", "theorem"], ["statement", "3", "lemma"], ["section", "3.2", ""], ["section", "4", ""]],
  );
  // Un año entre paréntesis sigue siendo una cita de autor, no una ecuación.
  assert.equal(citationAt("Smith (2019) show", 8).kind, "author");
  const eq = { kind: "equation", number: "6.1" };
  assert.ok(anchorScore(eq, "dim(V λ ) = n! / ∏ h(i,j) (6.1)") > anchorScore(eq, "(6.1)"));
  assert.ok(anchorScore(eq, "(6.1)") > anchorScore(eq, "as shown in the formula (6.1)"));
  assert.equal(anchorScore(eq, "by (6.1) we get"), 0);
  const theorem = { kind: "statement", word: "theorem", number: "2.3" };
  assert.ok(anchorScore(theorem, "Theorem 2.3. Let G be a finite group"));
  assert.ok(anchorScore(theorem, "Theorem 2.3 (Frobenius). Let"));
  assert.equal(anchorScore(theorem, "By Theorem 2.3 we have"), 0);
  assert.equal(anchorScore(theorem, "Theorem 2.31. Let"), 0);
  assert.equal(anchorScore(theorem, "Lemma 2.3. Let"), 0);
  const section = { kind: "section", number: "3.2" };
  assert.ok(anchorScore(section, "3.2 Hook lengths"));
  assert.equal(anchorScore(section, "In 3.2 we saw"), 0);
  assert.ok(anchorProbe(theorem).test("… Thm. 2.3 …"));
});

test("estructura del artículo: enunciados, ecuaciones y notación", async () => {
  const { extractStructure } = await import("../references.js");
  const L = (text) => ({ text, y: 0, size: 10 });
  const { statements, equations, notation } = extractStructure([
    { page: 3, lines: [L("Let λ be a partition of n and let V λ denote the irreducible module."), L("Theorem 2.3 (Frobenius). Let G be a finite group."), L("By Theorem 2.3 we have"), L("dim(V λ ) = n! / ∏ h(i,j) (6.1)"), L("as shown in (6.1)"), L("We write S n for the symmetric group. Let us now prove it.")] },
    { page: 4, lines: [L("Sea n un entero positivo. Denotamos por h(i,j) la longitud del gancho."), L("Lema 5.1. Sea G un grupo.")] },
  ]);
  assert.deepEqual(statements.map((s) => [s.word, s.number, s.name, s.page]), [["theorem", "2.3", "Frobenius", 3], ["lemma", "5.1", "", 4]]);
  assert.deepEqual(equations.map((e) => [e.number, e.page]), [["6.1", 3]]);
  const symbols = Object.fromEntries(notation.map((n) => [n.symbol, n.meaning]));
  assert.equal(symbols["λ"], "a partition of n");
  assert.equal(symbols["V λ"], "the irreducible module");
  assert.equal(symbols["S n"], "the symmetric group");
  assert.equal(symbols["h(i,j)"], "longitud del gancho");
  assert.equal(symbols["n"], "un entero positivo");
  assert.ok(!("us" in symbols));
});
