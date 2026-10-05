// Genera los PDF de prueba (una vez por ejecución) a partir de HTML.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { FIXTURES } from "./helpers.mjs";
import { buildZip } from "./zip-writer.mjs";

const PAPER = `<body style="font-family:serif;padding:40px;font-size:15px">
<h2>6. Dimensions of irreducible representations</h2>
<p>Let &lambda; be a partition of n and let V<sub>&lambda;</sub> be the irreducible S<sub>n</sub>-module (Specht module) associated with &lambda;.</p>
<p style="text-align:center;font-size:18px">dim(V<sub>&lambda;</sub>) = n! / &prod; h(i,j) &nbsp;&nbsp;&nbsp;&nbsp; (6.1)</p>
<p>Here h(i,j) denotes the hook length of the box (i,j) in the Young diagram of &lambda;. This is the hook length formula of Frame, Robinson and Thrall.</p>
<p style="margin-top:500px">Second part of the page.</p></body>`;

const REFS = `<style>body{font-family:serif;font-size:15px;padding:30px 50px} .pg{height:1000px;page-break-after:always} .eq{display:flex;justify-content:space-between;padding:0 120px;font-size:17px}</style>
<div class="pg"><h2>2. Representations of S<sub>n</sub></h2>
<p><b>Theorem 2.3.</b> Let λ be a partition of n. The Specht modules S<sup>λ</sup> are irreducible and pairwise non-isomorphic, and every irreducible representation of S<sub>n</sub> arises this way.</p>
<p>Proof. Standard; see James.</p>
<div class="eq"><span>dim(V<sub>λ</sub>) = n! / ∏ h(i,j)</span><span>(6.1)</span></div>
<p>where h(i,j) is the hook length.</p></div>
<div class="pg"><h3>3.2 Hook lengths</h3><p>The hook of a box consists of the box itself, the boxes to its right and the boxes below it.</p></div>
<div class="pg"><p>Combining Theorem 2.3 with (6.1) gives the dimension of every irreducible module; the combinatorics is explained in Section 3.2 of this paper.</p></div>`;

// Artículo con enlaces internos (como los de hyperref en LaTeX): «[2.1]» lleva
// a un teorema a media página, «[12]» a la bibliografía, «(3.4)» a una ecuación.
const LINKS = `<style>body{font-family:serif;font-size:15px;padding:30px 50px} .pg{height:1000px;page-break-after:always} a{color:#1a4fd0;text-decoration:none} .eq{display:flex;justify-content:space-between;padding:0 120px;font-size:17px}</style>
<div class="pg"><h2>1. Introduction</h2><p>The main result is Theorem <a href="#thm21">[2.1]</a>, which follows from the hook formula <a href="#eq34">(3.4)</a> and the classical work <a href="#ref12">[12]</a>. See also <a href="#intro">the start of this page</a>.</p><p id="intro">Nothing else here.</p></div>
<div class="pg"><p>Some preliminary text that fills the upper part of the second page before the statement appears.</p><p style="margin-top:380px" id="thm21"><b>Theorem 2.1.</b> Every irreducible representation of the symmetric group is a Specht module S<sup>λ</sup>.</p><p>Proof. Combine the hook formula with the branching rule.</p><div class="eq" id="eq34"><span>f<sup>λ</sup> = n! / ∏ h(i,j)</span><span>(3.4)</span></div></div>
<div class="pg"><h3>References</h3><p>[11] G. James, The representation theory of the symmetric groups, 1978.</p><p id="ref12">[12] J. S. Frame, G. Robinson, R. M. Thrall, The hook graphs of the symmetric group, 1954.</p></div>`;

// Libro EPUB 3: portada, índice con una subsección, imagen, nota al pie y
// (para comprobar que se eliminan) un script y un atributo onclick.
const paragraphs = (prefix, n) => Array.from({ length: n }, (_, i) => `<p>${prefix} ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>`).join("");
function epubFiles(png) {
  const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="es"><head><title>${title}</title><link rel="stylesheet" href="style.css"/><script>window.__epubScript = true;</script></head><body>${body}</body></html>`;
  return [
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: "OEBPS/content.opf", data: '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test:libro</dc:identifier><dc:title>El libro de prueba</dc:title><dc:creator>Ana Autora</dc:creator><dc:language>es</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/><item id="fig" href="images/fig.png" media-type="image/png"/><item id="css" href="style.css" media-type="text/css"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>' },
    { name: "OEBPS/nav.xhtml", data: xhtml("Índice", '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Capítulo 1: El comienzo</a></li><li><a href="text/ch2.xhtml">Capítulo 2: La travesía</a><ol><li><a href="text/ch2.xhtml#sec">La nota</a></li></ol></li></ol></nav>') },
    { name: "OEBPS/style.css", data: "body { color: red; }" },
    { name: "OEBPS/images/cover.png", data: png },
    { name: "OEBPS/images/fig.png", data: png },
    { name: "OEBPS/text/ch1.xhtml", data: xhtml("Capítulo 1", `<h1>Capítulo 1: El comienzo</h1><p onclick="window.__epubClick = true">Primer párrafo con una nota<a epub:type="noteref" href="ch2.xhtml#n1">1</a> y un <a href="https://example.com">enlace externo</a>.</p>${paragraphs("Párrafo", 30)}<figure><img src="../images/fig.png" alt="Figura"/><figcaption>Una figura</figcaption></figure>${paragraphs("Más texto", 10)}`) },
    { name: "OEBPS/text/ch2.xhtml", data: xhtml("Capítulo 2", `<h1>Capítulo 2: La travesía</h1>${paragraphs("Viaje", 30)}<h2 id="sec">La nota</h2><aside epub:type="footnote" id="n1"><p>Esta es la nota al pie del primer capítulo.</p></aside>${paragraphs("Final", 20)}`) },
  ];
}

export default async function globalSetup() {
  await mkdir(FIXTURES, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  await page.setContent(PAPER);
  await writeFile(`${FIXTURES}/paper.pdf`, await page.pdf({ format: "A4" }));
  await page.setContent(REFS);
  await writeFile(`${FIXTURES}/refs.pdf`, await page.pdf({ format: "A4" }));
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 450;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#1f6f5c";
      ctx.fillRect(0, 0, 300, 450);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 34px serif";
      ctx.fillText("El libro", 60, 200);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await writeFile(`${FIXTURES}/libro.epub`, buildZip(epubFiles(png)));
  await page.setContent(LINKS);
  await writeFile(`${FIXTURES}/links.pdf`, await page.pdf({ format: "A4" }));
  // Página escaneada: el texto es una imagen, sin capa de texto.
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1240;
    canvas.height = 1754;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fbfaf5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "bold 44px serif";
    ctx.fillText("Capitulo 3. Tablas de Young", 110, 180);
    ctx.font = "32px serif";
    ["Sea n un entero positivo y sea lambda una particion", "de n. Un diagrama de Young es una disposicion de", "casillas alineadas a la izquierda. La longitud del", "gancho de una casilla cuenta las casillas situadas", "a su derecha y debajo de ella, mas la propia casilla.", "", "Theorem 3.1. The number of standard Young tableaux", "equals n! divided by the product of hook lengths."].forEach((line, i) => ctx.fillText(line, 110, 280 + i * 52));
    return canvas.toDataURL("image/jpeg", 0.9);
  });
  await page.setContent(`<body style="margin:0"><img src="${image}" style="width:210mm;height:296mm;display:block"></body>`);
  await writeFile(`${FIXTURES}/scan.pdf`, await page.pdf({ format: "A4", margin: { top: 0, bottom: 0, left: 0, right: 0 } }));
  await browser.close();
}
