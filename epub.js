// Lectura de libros EPUB sin dependencias: el EPUB es un ZIP con XHTML.
// El ZIP se lee a mano (directorio central) y se descomprime con el
// DecompressionStream del navegador, así funciona también sin conexión.

const textDecoder = new TextDecoder();

// ---- ZIP ----
export function readZipDirectory(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Fin del directorio central: firma 0x06054b50 en los últimos 64 KB.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("No es un archivo ZIP/EPUB válido");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Directorio del ZIP dañado");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, view, entries };
}

export async function readZipEntry(zip, name) {
  const entry = zip.entries.get(name) || zip.entries.get(decodeURIComponent(name));
  if (!entry) return null;
  const { view, bytes } = zip;
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) throw new Error(`Compresión no admitida en ${name}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- Rutas dentro del libro ----
export function resolvePath(base, href) {
  const clean = String(href || "").split("#")[0];
  if (!clean) return base;
  if (/^[a-z]+:/i.test(clean)) return clean;
  const parts = (clean.startsWith("/") ? [] : base.split("/").slice(0, -1)).concat(clean.replace(/^\//, "").split("/"));
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  try {
    return decodeURIComponent(out.join("/"));
  } catch {
    return out.join("/");
  }
}

const MEDIA_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", avif: "image/avif" };
export function mediaTypeFor(path, fallback = "application/octet-stream") {
  return MEDIA_TYPES[String(path).split(".").pop().toLowerCase()] || fallback;
}

// ---- Estructura: metadatos, orden de lectura e índice ----
const byLocalName = (root, name) => [...root.getElementsByTagName("*")].filter((node) => node.localName === name);
const firstText = (root, name) => byLocalName(root, name)[0]?.textContent.replace(/\s+/g, " ").trim() || "";

export async function openEpub(buffer, parser = new DOMParser()) {
  const zip = readZipDirectory(buffer);
  const readText = async (path) => {
    const data = await readZipEntry(zip, path);
    return data ? textDecoder.decode(data) : null;
  };
  const parseXml = (text) => parser.parseFromString(text, "application/xml");
  const container = await readText("META-INF/container.xml");
  if (!container) throw new Error("Falta META-INF/container.xml: no parece un EPUB");
  const opfPath = byLocalName(parseXml(container), "rootfile")[0]?.getAttribute("full-path");
  const opfText = opfPath && (await readText(opfPath));
  if (!opfText) throw new Error("No se encuentra el paquete del libro (OPF)");
  const opf = parseXml(opfText);
  const manifest = new Map();
  for (const item of byLocalName(opf, "item")) {
    manifest.set(item.getAttribute("id"), {
      id: item.getAttribute("id"),
      href: resolvePath(opfPath, item.getAttribute("href")),
      type: item.getAttribute("media-type") || "",
      properties: (item.getAttribute("properties") || "").split(/\s+/),
    });
  }
  const spine = byLocalName(opf, "itemref")
    .filter((ref) => ref.getAttribute("linear") !== "no")
    .map((ref) => manifest.get(ref.getAttribute("idref")))
    .filter((item) => item && /x?html/.test(item.type || item.href));
  if (!spine.length) throw new Error("El libro no tiene capítulos legibles");
  const coverId = byLocalName(opf, "meta").find((meta) => meta.getAttribute("name") === "cover")?.getAttribute("content");
  const cover = [...manifest.values()].find((item) => item.properties.includes("cover-image")) || manifest.get(coverId) || null;
  const book = {
    title: firstText(opf, "title"),
    author: firstText(opf, "creator"),
    language: firstText(opf, "language"),
    chapters: spine.map((item) => ({ href: item.href, id: item.id })),
    coverHref: cover && /^image\//.test(cover.type || mediaTypeFor(cover.href)) ? cover.href : "",
    toc: [],
    readText,
    readBytes: (path) => readZipEntry(zip, path),
  };
  // Índice: documento de navegación de EPUB 3 o NCX de EPUB 2.
  const nav = [...manifest.values()].find((item) => item.properties.includes("nav"));
  if (nav) {
    const doc = parser.parseFromString((await readText(nav.href)) || "", "application/xhtml+xml");
    const tocNav = byLocalName(doc, "nav").find((node) => /toc/.test(node.getAttribute("epub:type") || node.getAttributeNS?.("http://www.idpf.org/2007/ops", "type") || "")) || byLocalName(doc, "nav")[0];
    const walk = (list) =>
      byLocalName(list, "li")
        .filter((li) => li.parentNode === list)
        .map((li) => {
          const link = [...li.children].find((child) => child.localName === "a" || child.localName === "span");
          const sub = [...li.children].find((child) => child.localName === "ol" || child.localName === "ul");
          return { label: link?.textContent.replace(/\s+/g, " ").trim() || "", href: link?.getAttribute("href") ? resolveHref(nav.href, link.getAttribute("href")) : "", children: sub ? walk(sub) : [] };
        })
        .filter((entry) => entry.label);
    const top = tocNav && [...tocNav.children].find((child) => child.localName === "ol" || child.localName === "ul");
    if (top) book.toc = walk(top);
  }
  if (!book.toc.length) {
    const ncxItem = [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml");
    const ncxText = ncxItem && (await readText(ncxItem.href));
    if (ncxText) {
      const ncx = parseXml(ncxText);
      const walk = (parent) =>
        [...parent.children]
          .filter((child) => child.localName === "navPoint")
          .map((point) => ({
            label: firstText([...point.children].find((child) => child.localName === "navLabel") || point, "text"),
            href: resolveHref(ncxItem.href, byLocalName(point, "content")[0]?.getAttribute("src") || ""),
            children: walk(point),
          }))
          .filter((entry) => entry.label);
      const map = byLocalName(ncx, "navMap")[0];
      if (map) book.toc = walk(map);
    }
  }
  return book;
}
// «capitulo.xhtml#nota» relativo a `base` → «OEBPS/capitulo.xhtml#nota».
export function resolveHref(base, href) {
  const [path, hash = ""] = String(href).split("#");
  return `${path ? resolvePath(base, path) : base}${hash ? `#${hash}` : ""}`;
}

// ---- Capítulos: XHTML del libro → HTML limpio para el lector ----
// Solo pasan etiquetas de texto e imágenes, sin scripts, estilos ni eventos.
// Los ids se prefijan con el número de capítulo para que no choquen entre sí
// y los enlaces internos apuntan a esos ids.
const ALLOWED_TAGS = new Set(["p", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "em", "i", "strong", "b", "u", "s", "sub", "sup", "small", "br", "hr", "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "img", "figure", "figcaption", "a", "section", "article", "aside", "header", "footer", "pre", "code", "cite", "q", "abbr", "mark", "del", "ins", "ruby", "rt", "rp"]);
const DROP_TAGS = new Set(["script", "style", "link", "meta", "title", "head", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "noscript", "audio", "video", "template"]);
export function chapterAnchor(chapterIndex, id = "") {
  return `epub-${chapterIndex}${id ? `-${String(id).replace(/[^\w-]/g, "_")}` : ""}`;
}
// Las imágenes quedan con `data-epub-src` (ruta dentro del libro): la app las
// carga cuando se acercan a la pantalla.
export function cleanChapter(xhtml, { chapterIndex, chapterHref, chapterIndexByHref, parser = new DOMParser(), ownerDocument = document }) {
  let doc = parser.parseFromString(xhtml, "application/xhtml+xml");
  if (byLocalName(doc, "parsererror").length) doc = parser.parseFromString(xhtml, "text/html");
  const body = byLocalName(doc, "body")[0] || doc.documentElement;
  const fragment = ownerDocument.createDocumentFragment();
  const copy = (node, parent) => {
    if (node.nodeType === 3) {
      parent.append(ownerDocument.createTextNode(node.nodeValue));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.localName.toLowerCase();
    if (DROP_TAGS.has(tag)) return;
    // Imágenes dentro de SVG (portadas): se convierten en <img>.
    if (tag === "svg") {
      const image = byLocalName(node, "image")[0];
      const href = image && (image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink", "href"));
      if (href) {
        const img = ownerDocument.createElement("img");
        img.dataset.epubSrc = resolvePath(chapterHref, href);
        img.alt = "";
        parent.append(img);
      }
      return;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      [...node.childNodes].forEach((child) => copy(child, parent));
      return;
    }
    const out = ownerDocument.createElement(tag);
    const id = node.getAttribute("id");
    if (id) out.id = chapterAnchor(chapterIndex, id);
    const lang = node.getAttribute("lang") || node.getAttribute("xml:lang");
    if (lang) out.lang = lang;
    for (const name of ["colspan", "rowspan", "alt", "title"]) if (node.hasAttribute(name)) out.setAttribute(name, node.getAttribute(name));
    const type = node.getAttribute("epub:type") || node.getAttributeNS?.("http://www.idpf.org/2007/ops", "type");
    if (type) out.dataset.epubType = type;
    if (tag === "img") {
      const src = node.getAttribute("src");
      if (!src || /^(https?:|data:)/i.test(src)) return;
      out.dataset.epubSrc = resolvePath(chapterHref, src);
    }
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) {
        out.href = href;
        out.target = "_blank";
        out.rel = "noopener noreferrer";
      } else if (href) {
        const target = resolveHref(chapterHref, href);
        const [path, hash] = target.split("#");
        const index = chapterIndexByHref.get(path);
        if (index !== undefined) {
          out.href = `#${chapterAnchor(index, hash)}`;
          out.dataset.epubLink = "1";
        }
      }
    }
    [...node.childNodes].forEach((child) => copy(child, out));
    parent.append(out);
  };
  [...body.childNodes].forEach((child) => copy(child, fragment));
  return fragment;
}
