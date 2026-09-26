// ---- Referencias bibliográficas ----
// Funciones puras (sin DOM ni pdf.js) para: reconstruir líneas respetando las
// columnas, localizar la bibliografía de un artículo, separar sus entradas,
// reconocer DOI/arXiv/autores/año, casar una cita del texto («[12]»,
// «Smith et al., 2019») con su entrada y exportar a BibTeX o RIS (Zotero).

const HEADING = /^(?:\d+(?:\.\d+)*\.?\s+|[IVX]+\.\s+)?(references|bibliography|referencias|referencias bibliográficas|bibliografía|bibliografia|works cited|literature cited|literatura citada|références|literatur)\s*:?$/i;
const STOP_HEADING = /^(?:[A-Z]\.?\s+|\d+\.?\s+)?(appendix|appendices|apéndice|apéndices|anexo|anexos|supplementary|supplemental|annex)\b/i;

// items: [{ str, x, y, w, h }] en coordenadas PDF (y crece hacia arriba).
export function buildLines(items, pageWidth) {
  const clean = items.filter((item) => item.str && item.str.trim());
  if (!clean.length) return [];
  const mid = pageWidth / 2;
  const left = clean.filter((item) => item.x + item.w < mid - 4);
  const right = clean.filter((item) => item.x > mid + 4);
  const crossing = clean.length - left.length - right.length;
  const twoColumns = left.length >= 4 && right.length >= 4 && crossing <= Math.max(2, clean.length * 0.12);
  const groups = twoColumns ? [[...left, ...clean.filter((item) => item.x + item.w >= mid - 4 && item.x <= mid + 4)], right] : [clean];
  const lines = [];
  groups.forEach((group, column) => {
    const sorted = [...group].sort((a, b) => b.y - a.y || a.x - b.x);
    let current = null;
    for (const item of sorted) {
      const size = Math.max(4, item.h || 10);
      if (!current || Math.abs(current.y - item.y) > Math.max(2, size * 0.45)) {
        current = { y: item.y, x: item.x, size, column, parts: [] };
        lines.push(current);
      }
      current.parts.push(item);
      current.x = Math.min(current.x, item.x);
      current.size = Math.max(current.size, size);
    }
  });
  return lines.map((line) => {
    const parts = line.parts.sort((a, b) => a.x - b.x);
    let text = "";
    let end = null;
    for (const part of parts) {
      const gap = end === null ? 0 : part.x - end;
      text += (text && (gap > line.size * 0.12 || /\s$/.test(text)) ? " " : "") + part.str.trim();
      end = part.x + part.w;
    }
    return { text: text.replace(/\s{2,}/g, " ").trim(), x: line.x, y: line.y, size: line.size, column: line.column };
  }).filter((line) => line.text);
}

function joinLine(text, next) {
  if (/[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(next)) return text.slice(0, -1) + next;
  return `${text} ${next}`;
}

// pages: [{ page, lines }] (lines de buildLines). Devuelve las entradas.
export function extractReferences(pages) {
  let start = null;
  for (let p = pages.length - 1; p >= 0 && !start; p--) {
    const lines = pages[p].lines;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].text.length < 48 && HEADING.test(lines[i].text.trim())) {
        start = { p, i };
        break;
      }
    }
  }
  if (!start) return [];
  const refLines = [];
  outer: for (let p = start.p; p < pages.length; p++) {
    const lines = pages[p].lines;
    for (let i = p === start.p ? start.i + 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.text.length < 60 && STOP_HEADING.test(line.text)) break outer;
      // Cabeceras o pies de página cortos (número de página, título corrido).
      if (/^\d{1,4}$/.test(line.text)) continue;
      refLines.push({ ...line, page: pages[p].page });
    }
  }
  if (!refLines.length) return [];
  const bracket = refLines.filter((line) => /^\[\d{1,4}\]/.test(line.text)).length;
  const dotted = refLines.filter((line) => /^\d{1,4}\.\s+\S/.test(line.text)).length;
  const entries = [];
  let current = null;
  const push = () => {
    if (current?.text) entries.push(current);
    current = null;
  };
  if (bracket >= 2 || dotted >= 3) {
    const labelRe = bracket >= 2 ? /^\[(\d{1,4})\]\s*/ : /^(\d{1,4})\.\s+/;
    for (const line of refLines) {
      const match = line.text.match(labelRe);
      if (match) {
        push();
        current = { label: match[1], text: line.text.slice(match[0].length), page: line.page, y: line.y, column: line.column };
      } else if (current) current.text = joinLine(current.text, line.text);
    }
    push();
    return entries.map(finishEntry);
  }
  // Autor-año: sangría francesa (la primera línea sobresale) o, si no la
  // hay, una línea que empieza por «Apellido,» tras otra que acaba en punto.
  const minX = new Map();
  for (const line of refLines) {
    const k = `${line.page}:${line.column}`;
    minX.set(k, Math.min(minX.get(k) ?? Infinity, line.x));
  }
  const hanging = refLines.some((line) => line.x > minX.get(`${line.page}:${line.column}`) + 4);
  for (const line of refLines) {
    const atMargin = line.x <= minX.get(`${line.page}:${line.column}`) + 2;
    const looksNew = /^[A-ZÀ-Ý][\p{L}'’-]+(?:\s[A-ZÀ-Ý][\p{L}'’-]+)?,\s/u.test(line.text) && (!current || /[.)]\s*$/.test(current.text));
    if (!current || (hanging ? atMargin : looksNew)) {
      push();
      current = { label: "", text: line.text, page: line.page, y: line.y, column: line.column };
    } else current.text = joinLine(current.text, line.text);
  }
  push();
  return entries.map(finishEntry);
}

function finishEntry(entry, index) {
  return { ...entry, index, text: entry.text.replace(/\s{2,}/g, " ").trim(), ...parseReference(entry.text) };
}

export function findDoi(text) {
  const match = String(text || "").match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
  return match ? match[1].replace(/[.,;:)\]]+$/, "") : "";
}
export function findArxiv(text) {
  const match = String(text || "").match(/arxiv(?:\.org\/abs\/|:\s*|\s+)(\d{4}\.\d{4,5})(v\d+)?/i) || String(text || "").match(/10\.48550\/arXiv\.(\d{4}\.\d{4,5})/i);
  return match ? match[1] : "";
}

// Reconoce autores, año, título, DOI, arXiv y URL de una entrada.
export function parseReference(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  const doi = findDoi(text);
  const arxiv = findArxiv(text);
  const url = (text.match(/https?:\/\/[^\s<>"]+/) || [""])[0].replace(/[.,;)]+$/, "");
  const parenYear = text.match(/\((\d{4})[a-z]?\)/);
  const years = [...text.matchAll(/\b(1[89]\d{2}|20\d{2})[a-z]?\b/g)].map((match) => match[1]);
  const year = parenYear ? parenYear[1] : years.find((value) => !doi.includes(value)) || years[0] || "";
  let authors = "",
    title = "";
  const ay = text.match(/^(.+?)\s*\((\d{4})[a-z]?\)\.?\s*(.+?)(?:\.\s|\?\s|$)/);
  if (ay) {
    // Se quita la coma final, no el punto: puede ser el de una inicial.
    authors = ay[1].replace(/,\s*$/, "");
    title = ay[3];
  } else {
    // «I. Beltagy, M. E. Peters, and A. Cohan. Título. Revista…»: el bloque de
    // autores termina en el primer punto que no sigue a una inicial.
    const end = [...text.matchAll(/\.\s/g)].find((match) => !/(?:^|[\s.-])[A-ZÀ-Ý]$/u.test(text.slice(0, match.index)) && !/\bet al$/.test(text.slice(0, match.index)));
    if (end) {
      authors = text.slice(0, end.index);
      const rest = text.slice(end.index + 2);
      title = (rest.match(/^(.+?)(?:\.\s|\?\s|$)/) || ["", rest])[1];
    }
  }
  const surnames = authorSurnames(authors);
  return { doi, arxiv, url, year, authors, title: title.trim().replace(/^["“]|["”]$/g, ""), surnames };
}

export function authorSurnames(authors) {
  const text = String(authors || "").replace(/\bet al\.?/g, "").trim();
  if (!text) return [];
  // «Apellido, I., Apellido2, J. and …»
  if (/^[\p{Lu}][\p{L}'’-]+,\s*\p{Lu}\./u.test(text)) {
    return [...text.matchAll(/(?:^|,\s*(?:and\s+|&\s+|y\s+)?|\s(?:and|&|y)\s+)([\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?),\s*(?:\p{Lu}\.[\s-]*)+/gu)].map((match) => match[1]);
  }
  // «I. Apellido, M. E. Apellido2, and A. Apellido3»
  return text
    .split(/,\s*(?:and\s+|&\s+|y\s+)?|\s+(?:and|&|y)\s+/)
    .map((name) => name.trim().split(/\s+/).filter((part) => !/^\p{Lu}\.(?:-?\p{Lu}\.)*$/u.test(part)).pop() || "")
    .filter((name) => /^[\p{Lu}][\p{L}'’-]+$/u.test(name));
}

// Detecta una cita en un fragmento de texto alrededor de `offset`.
export function citationAt(text, offset = null) {
  const patterns = [
    { kind: "numeric", re: /\[(\d{1,4}(?:\s*[,–-]\s*\d{1,4})*)\]/g },
    { kind: "figure", re: /\b(Fig(?:ure|ura)?s?\.?)\s*(\d{1,3}[a-z]?)\b/gi },
    { kind: "table", re: /\b(Tab(?:le|la)s?\.?)\s*(\d{1,3})\b/gi },
    { kind: "author", re: /([\p{Lu}][\p{L}'’-]+)(?:\s+et\s+al\.?|\s+(?:and|&|y)\s+[\p{Lu}][\p{L}'’-]+)?(?:,\s*|\s+\()(\d{4})[a-z]?\b/gu },
  ];
  let best = null;
  const all = [...patterns, ...STRUCTURE_PATTERNS];
  for (const { kind, re } of all) {
    for (const match of text.matchAll(re)) {
      const start = match.index,
        end = start + match[0].length;
      const hit = offset === null || (offset >= start - 1 && offset <= end + 1);
      if (!hit) continue;
      const distance = offset === null ? start : Math.abs((start + end) / 2 - offset);
      if (best && best.distance <= distance) continue;
      if (kind === "numeric") {
        const numbers = match[1].split(/\s*,\s*/).flatMap((part) => {
          const range = part.match(/^(\d+)\s*[–-]\s*(\d+)$/);
          if (!range) return [Number(part)];
          const from = Number(range[1]), to = Number(range[2]);
          return to >= from && to - from < 40 ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : [from];
        });
        best = { kind, numbers, label: match[0], distance };
      } else if (kind === "author") best = { kind, surname: match[1], year: match[2], label: match[0], distance };
      else if (kind === "equation") best = { kind, number: match[1] || match[2], label: match[0], distance };
      else if (kind === "statement") best = { kind, word: canonicalStatement(match[1]), number: match[2], label: match[0], distance };
      else if (kind === "section") best = { kind, number: match[1], label: match[0], distance };
      else best = { kind, number: match[2], word: match[1], label: match[0], distance };
    }
  }
  return best;
}

// ---- Referencias internas de artículos matemáticos ----
// «(6.1)», «Eq. 3», «Theorem 2.3», «Lema 4», «Section 3.2»: se localiza el
// enunciado o la ecuación en el propio documento (como hace Sioyek).
const STATEMENT_WORDS = {
  theorem: ["Theorem", "Thm", "Teorema"],
  lemma: ["Lemma", "Lem", "Lema"],
  proposition: ["Proposition", "Prop", "Proposición", "Proposicion"],
  corollary: ["Corollary", "Cor", "Corolario"],
  definition: ["Definition", "Def", "Definición", "Definicion"],
  remark: ["Remark", "Rem", "Observación", "Observacion", "Nota"],
  example: ["Example", "Ejemplo"],
  conjecture: ["Conjecture", "Conjetura"],
  claim: ["Claim", "Afirmación"],
  exercise: ["Exercise", "Ejercicio", "Problem", "Problema"],
  algorithm: ["Algorithm", "Algoritmo"],
  assumption: ["Assumption", "Hypothesis", "Hipótesis", "Supuesto"],
};
export const STATEMENT_LABELS = {
  theorem: "Teorema", lemma: "Lema", proposition: "Proposición", corollary: "Corolario", definition: "Definición", remark: "Observación",
  example: "Ejemplo", conjecture: "Conjetura", claim: "Afirmación", exercise: "Ejercicio", algorithm: "Algoritmo", assumption: "Hipótesis",
};
const STATEMENT_ALTERNATION = Object.values(STATEMENT_WORDS).flat().sort((a, b) => b.length - a.length).join("|");
const NUMBER = "\\d{1,3}(?:\\.\\d{1,3}){0,3}[a-z]?";
const STRUCTURE_PATTERNS = [
  // Ecuación con palabra («Eq. (3)», «ecuación 2.4») o solo entre paréntesis
  // («(6.1)»); cuatro cifras seguidas serían un año, no una ecuación.
  { kind: "equation", re: new RegExp(`\\b(?:Eqs?\\.?|Equations?|Eqn\\.?|ecuaci[oó]n(?:es)?)\\s*\\(?(${NUMBER})\\)?|\\((${NUMBER})\\)`, "gi") },
  { kind: "statement", re: new RegExp(`\\b(${STATEMENT_ALTERNATION})s?\\.?\\s*(${NUMBER})\\b`, "g") },
  { kind: "section", re: new RegExp(`(?:\\b(?:Sections?|Secci[oó]n(?:es)?|Secs?\\.|Chapter|Cap[ií]tulo)|§)\\s*(${NUMBER})\\b`, "gi") },
];
function canonicalStatement(word) {
  const clean = String(word).replace(/\.$/, "").toLowerCase();
  return Object.keys(STATEMENT_WORDS).find((key) => STATEMENT_WORDS[key].some((alias) => alias.toLowerCase() === clean)) || "theorem";
}
const escapeNumber = (number) => String(number).replace(/[.]/g, "\\.");
// Puntuación de una línea como destino de la referencia (0 = no lo es). Así se
// distingue «Theorem 2.3.» al empezar un enunciado de «by Theorem 2.3 we…».
export function anchorScore(citation, text) {
  const line = String(text || "").trim();
  const number = escapeNumber(citation.number);
  if (citation.kind === "equation") {
    if (!new RegExp(`\\(${number}\\)$`).test(line)) return 0;
    const body = line.replace(new RegExp(`\\(${number}\\)$`), "").trim();
    if (!body) return 2;
    if (/[=<>≤≥≈∼≡⊂⊆∈∑∏∫+−×·/^_|]|\\[a-z]/.test(body)) return 3;
    // Prosa que termina en la etiqueta («as shown in (6.1)»): último recurso.
    return /\b\p{Ll}{2,}\s+\p{Ll}{2,}\s+\p{Ll}{2,}\b/u.test(body) ? 1 : 2;
  }
  if (citation.kind === "statement") {
    const words = STATEMENT_WORDS[citation.word] || [];
    const re = new RegExp(`^(?:${words.join("|")})\\.?\\s*${number}(?![\\d.]\\d)\\s*(?:[.:(\\[—–-]|$|\\p{Lu})`, "u");
    return re.test(line) ? 3 : 0;
  }
  if (citation.kind === "section") {
    if (new RegExp(`^(?:Section|Sección|Chapter|Capítulo|§)?\\s*${number}\\.?\\s+\\p{Lu}`, "u").test(line) && line.length < 90) return 3;
    return 0;
  }
  return 0;
}
// Texto que debe aparecer en una página para que merezca la pena mirarla.
export function anchorProbe(citation) {
  const number = escapeNumber(citation.number);
  if (citation.kind === "equation") return new RegExp(`\\(${number}\\)`);
  if (citation.kind === "statement") return new RegExp(`(?:${(STATEMENT_WORDS[citation.word] || []).join("|")})\\.?\\s*${number}`);
  return new RegExp(`${number}\\.?\\s+\\p{Lu}`, "u");
}

// ---- Estructura de un artículo: enunciados, ecuaciones y notación ----
// A partir de las líneas de cada página ([{ page, lines }]) reúne los
// enunciados numerados («Theorem 2.3 (Frobenius). …»), las ecuaciones con
// etiqueta y las frases que introducen símbolos («Let λ be a partition…»).
const STATEMENT_START = new RegExp(`^(${STATEMENT_ALTERNATION})\\.?\\s*(${NUMBER})(?![\\d.]\\d)\\s*(?:\\(([^)]{1,60})\\))?\\s*[.:—–-]?\\s*(.*)$`, "u");
const SYM = "(\\S{1,14}(?:\\s\\S{1,3})?)";
const NOTATION_PATTERNS = [
  new RegExp(`\\b(?:Let|let)\\s+${SYM}\\s+(?:be|denote)\\s+([^.;]{3,90})`, "gu"),
  new RegExp(`\\b[Ww]e\\s+(?:write|denote|use)\\s+(?:by\\s+)?${SYM}\\s+(?:for|to denote|the)\\s+([^.;]{3,90})`, "gu"),
  new RegExp(`(?:^|[\\s,(])${SYM}\\s+(?:denotes|stands for)\\s+([^.;]{3,90})`, "gu"),
  new RegExp(`\\b(?:Sea|sea|Sean|sean)\\s+${SYM}\\s+((?:un|una|el|la|los|las|unos|unas)\\s+[^.;]{3,90})`, "gu"),
  new RegExp(`\\b(?:[Dd]enotamos|[Ll]lamamos|[Ee]scribimos)\\s+(?:por\\s+|como\\s+)?${SYM}\\s+(?:a\\s+|al\\s+|la\\s+|el\\s+)?([^.;]{3,90})`, "gu"),
  new RegExp(`(?:^|[\\s,(])${SYM}\\s+denota\\s+([^.;]{3,90})`, "gu"),
];
const NOT_SYMBOLS = new Set("the this that these those us it its we he she they them one each any all some a an and or of to in on at is be as by for with from which who what when where there here then than also such its its un una el la los las lo le les se que de del en con por para como esto este esta estos estas ese esa eso".split(" "));
function looksLikeSymbol(token) {
  const symbol = token.replace(/^[\[{,]+|[\]},:.]+$/g, "").replace(/^\((?![^)]*\()/, "").trim();
  if (!symbol || symbol.length > 14) return "";
  let [head, tail] = symbol.split(" ");
  if (NOT_SYMBOLS.has(head.toLowerCase())) return "";
  // «h(i,j) la longitud…»: el artículo no es un subíndice.
  if (tail && NOT_SYMBOLS.has(tail.toLowerCase())) return looksLikeSymbol(head);
  // «V λ», «S n»: letra con subíndice que el PDF separa; el segundo trozo es corto.
  if (tail && (!/^[\p{L}\p{N}]{1,3}$/u.test(tail) || head.length > 3)) return "";
  if (!/^[\p{L}\p{N}_^'′*∗~\\{}()|+−,-]+$/u.test(symbol.replace(" ", ""))) return "";
  // Una palabra corriente en minúsculas («partition») no es un símbolo.
  if (/^\p{Ll}{4,}$/u.test(symbol) && !/[\u0370-\u03ff]/u.test(symbol)) return "";
  return symbol;
}
export function extractStructure(pages) {
  const statements = [];
  const equations = [];
  const notation = [];
  const seenSymbols = new Set();
  const seenStatements = new Set();
  for (const { page, lines } of pages) {
    lines.forEach((line, index) => {
      const text = line.text.trim();
      const statement = text.match(STATEMENT_START);
      if (statement) {
        const citation = { kind: "statement", word: canonicalStatement(statement[1]), number: statement[2] };
        const id = `${citation.word}:${citation.number}`;
        if (!seenStatements.has(id) && anchorScore(citation, text)) {
          seenStatements.add(id);
          const next = lines[index + 1]?.text || "";
          statements.push({ ...citation, name: statement[3] || "", page, y: line.y, snippet: `${statement[4]} ${next}`.trim().slice(0, 140) });
        }
      }
      const label = text.match(/\((\d{1,3}(?:\.\d{1,3}){0,3}[a-z]?)\)$/);
      if (label && anchorScore({ kind: "equation", number: label[1] }, text) >= 2) {
        const body = text.slice(0, -label[0].length).trim();
        if (body && !equations.some((equation) => equation.number === label[1])) equations.push({ kind: "equation", number: label[1], page, y: line.y, snippet: body.slice(0, 120) });
      }
    });
    const joined = lines.map((line) => line.text).join(" ").replace(/\s+/g, " ");
    for (const pattern of NOTATION_PATTERNS) {
      pattern.lastIndex = 0;
      // Búsqueda solapada: «Let λ be a partition and let V λ denote…» tiene dos.
      for (let match; (match = pattern.exec(joined)); pattern.lastIndex = match.index + match[0].indexOf(match[1]) + match[1].length) {
        const symbol = looksLikeSymbol(match[1]);
        if (!symbol || seenSymbols.has(symbol)) continue;
        seenSymbols.add(symbol);
        const start = Math.max(0, joined.lastIndexOf(".", match.index) + 1);
        const end = joined.indexOf(".", match.index + match[0].length);
        const sentence = joined.slice(start, end < 0 ? undefined : end + 1).trim();
        // El significado termina donde empieza otra definición («… and let V be …»).
        const meaning = (match[2] || sentence).split(/,?\s+(?:and|y)\s+(?:let|sea|sean|we)\b|\s+where\s+|\s+donde\s+/i)[0];
        notation.push({ symbol, meaning: meaning.trim().replace(/[,:]$/, "").slice(0, 110), sentence: sentence.slice(0, 220), page });
      }
    }
  }
  return { statements, equations, notation };
}

export function findEntryForCitation(entries, citation) {
  if (!citation || !entries?.length) return [];
  if (citation.kind === "numeric") return citation.numbers.map((n) => entries.find((entry) => entry.label === String(n))).filter(Boolean);
  if (citation.kind === "author") {
    const surname = citation.surname.toLowerCase();
    const hits = entries.filter((entry) => entry.year === citation.year && (entry.surnames[0]?.toLowerCase() === surname || entry.text.slice(0, 60).toLowerCase().includes(surname)));
    return hits.slice(0, 2);
  }
  return [];
}

// Localiza el pie de figura o tabla (una línea que empieza por «Figure 3:»).
export function captionPattern(kind, number) {
  const word = kind === "table" ? "(?:Table|Tabla|Tab\\.)" : "(?:Figure|Figura|Fig\\.)";
  return new RegExp(`^\\s*${word}\\s*${String(number).replace(/[^0-9a-z]/gi, "")}\\s*[:.|—–-]`, "i");
}

// ---- Exportación ----
function latexEscape(value) {
  return String(value || "").replace(/([{}%&#_$])/g, "\\$1");
}
function asciiKey(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "");
}
export function bibKey(meta, fallback = "ref") {
  const surname = asciiKey(meta.surnames?.[0] || "").toLowerCase();
  const word = asciiKey((String(meta.title || "").match(/[\p{L}]{4,}/u) || [""])[0]).toLowerCase();
  return `${surname || fallback}${meta.year || ""}${word}` || fallback;
}
// Lista de autores en formato BibTeX («Apellido, I. and Apellido2, J.»).
export function authorList(meta) {
  if (Array.isArray(meta.authorList) && meta.authorList.length) return meta.authorList;
  const text = String(meta.authors || "").replace(/\bet al\.?/g, "").trim();
  if (!text) return [];
  // «Apellido, I., Apellido2, J. y Apellido3, K.»
  if (/^[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?,\s*\p{Lu}\./u.test(text)) {
    return [...text.matchAll(/([\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?),\s*((?:\p{Lu}\.[\s-]*)+)/gu)].map((match) => `${match[1]}, ${match[2].trim()}`);
  }
  // «I. Apellido, M. E. Apellido2, and A. Apellido3»
  return text.split(/,\s*(?:and\s+|&\s+|y\s+)?|\s+(?:and|&|y)\s+/).map((name) => name.trim()).filter((name) => /\p{L}{2}/u.test(name));
}
function bibAuthors(meta) {
  return authorList(meta).join(" and ");
}
export function toBibtex(meta, key = bibKey(meta)) {
  const fields = [
    ["author", bibAuthors(meta)],
    ["title", meta.title],
    ["year", meta.year],
    ["journal", meta.journal],
    ["doi", meta.doi],
    ["eprint", meta.arxiv],
    ["archivePrefix", meta.arxiv ? "arXiv" : ""],
    ["url", meta.url && !meta.doi ? meta.url : ""],
    ["note", !meta.title && meta.text ? meta.text : ""],
  ].filter(([, value]) => value);
  const type = meta.journal ? "article" : "misc";
  // El título va entre llaves dobles para que BibTeX respete las mayúsculas.
  const format = (name, value) => (name === "title" ? `{${latexEscape(value)}}` : name === "url" ? value : latexEscape(value));
  return `@${type}{${key},\n${fields.map(([name, value]) => `  ${name} = {${format(name, value)}}`).join(",\n")}\n}`;
}
export function toRis(meta) {
  const lines = [`TY  - ${meta.journal ? "JOUR" : "GEN"}`];
  authorList(meta).forEach((author) => lines.push(`AU  - ${author}`));
  if (meta.title) lines.push(`TI  - ${meta.title}`);
  if (meta.journal) lines.push(`JO  - ${meta.journal}`);
  if (meta.year) lines.push(`PY  - ${meta.year}`);
  if (meta.doi) lines.push(`DO  - ${meta.doi}`);
  if (meta.arxiv) lines.push(`UR  - https://arxiv.org/abs/${meta.arxiv}`);
  else if (meta.url) lines.push(`UR  - ${meta.url}`);
  if (meta.text) lines.push(`N1  - ${meta.text}`);
  lines.push("ER  - ");
  return lines.join("\n");
}
// Cita breve legible: «Beltagy, Peters y Cohan (2020). Longformer…».
export function formatCitation(meta) {
  const names = meta.surnames?.length ? meta.surnames : [];
  const who = names.length > 2 ? `${names[0]} et al.` : names.join(" y ");
  return [who && `${who}${meta.year ? ` (${meta.year})` : ""}`, meta.title, meta.doi ? `https://doi.org/${meta.doi}` : meta.arxiv ? `arXiv:${meta.arxiv}` : ""].filter(Boolean).join(". ").replace(/\.\./g, ".");
}
// Convierte la respuesta CSL-JSON de doi.org/Crossref en metadatos.
export function metaFromCsl(csl) {
  const authorList = (csl.author || []).map((author) => (author.family ? `${author.family}, ${author.given || ""}`.trim().replace(/,$/, "") : author.literal)).filter(Boolean);
  const year = String(csl.issued?.["date-parts"]?.[0]?.[0] || csl.published?.["date-parts"]?.[0]?.[0] || "");
  return {
    title: Array.isArray(csl.title) ? csl.title[0] : csl.title || "",
    authorList,
    surnames: (csl.author || []).map((author) => author.family).filter(Boolean),
    year,
    journal: Array.isArray(csl["container-title"]) ? csl["container-title"][0] : csl["container-title"] || "",
    doi: csl.DOI || "",
    url: csl.URL || "",
  };
}
