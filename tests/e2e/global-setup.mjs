// Genera los PDF de prueba (una vez por ejecución) a partir de HTML.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { FIXTURES } from "./helpers.mjs";

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

export default async function globalSetup() {
  await mkdir(FIXTURES, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  await page.setContent(PAPER);
  await writeFile(`${FIXTURES}/paper.pdf`, await page.pdf({ format: "A4" }));
  await page.setContent(REFS);
  await writeFile(`${FIXTURES}/refs.pdf`, await page.pdf({ format: "A4" }));
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
