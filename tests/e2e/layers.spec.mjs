import { test, expect } from "@playwright/test";
import { stat } from "node:fs/promises";
import { offlineCdn, openDoc, FIXTURES } from "./helpers.mjs";

// Capas de planos y dibujos técnicos, y apertura rápida de PDFs grandes.
test.use({ viewport: { width: 1400, height: 900 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
// Tinta (píxeles oscuros) en una franja horizontal de la página, de 0 a 1.
const ink = (page, from, to) =>
  page.evaluate(([from, to]) => {
    const canvas = document.querySelector("#pdfCanvas");
    const y0 = Math.floor(canvas.height * from);
    const data = canvas.getContext("2d").getImageData(0, y0, canvas.width, Math.floor(canvas.height * to) - y0).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 110 && data[i + 3] > 200) dark++;
    return dark;
  }, [from, to]);

test("capas: se listan, se apagan y encienden, y se recuerdan", async ({ page }) => {
  await openDoc(page, "layers.pdf");
  const rows = page.locator("#layerList .layer-row");
  await expect(page.locator("#layersSection")).toBeVisible();
  await expect(rows).toHaveText(["Cotas", "Notas"]);
  await expect(page.locator("#layerCount")).toHaveText("2 de 2");
  // «Cotas» está en la franja del 20–35 % de la página; «Notas», en el 60–68 %.
  expect(await ink(page, 0.2, 0.35)).toBeGreaterThan(200);
  expect(await ink(page, 0.6, 0.68)).toBeGreaterThan(200);
  await rows.filter({ hasText: "Cotas" }).locator("input").uncheck();
  await expect.poll(() => ink(page, 0.2, 0.35)).toBe(0);
  expect(await ink(page, 0.6, 0.68)).toBeGreaterThan(200);
  expect(await ink(page, 0.02, 0.12)).toBeGreaterThan(100);
  await expect(page.locator("#layerCount")).toHaveText("1 de 2");
  // Se recuerda al volver a abrir.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('#layerList [data-layer]').first()).not.toBeChecked();
  await expect.poll(() => ink(page, 0.6, 0.68)).toBeGreaterThan(200);
  expect(await ink(page, 0.2, 0.35)).toBe(0);
  // «Ninguna» y «Todas».
  await page.click('[data-layers-all="off"]');
  await expect.poll(() => ink(page, 0.6, 0.68)).toBe(0);
  await page.click('[data-layers-all="on"]');
  await expect.poll(() => ink(page, 0.2, 0.35)).toBeGreaterThan(200);
  // También desde el menú; un PDF sin capas no lo ofrece.
  await page.click("#mobileMoreBtn");
  await expect(page.locator('[data-mm="layers"]')).toHaveText("Capas");
  await page.keyboard.press("Escape");
  await page.setInputFiles("#fileInput", [`${FIXTURES}/paper.pdf`]);
  await expect(page.locator("#docTitle")).toContainText(/paper/i);
  await expect(page.locator("#layersSection")).toBeHidden();
});

test("un PDF grande se abre leyendo solo los trozos que necesita", async ({ page }) => {
  const size = (await stat(`${FIXTURES}/big.pdf`)).size;
  expect(size).toBeGreaterThan(3 * 1024 * 1024);
  await page.addInitScript(() => {
    window.__sliced = 0;
    const slice = Blob.prototype.slice;
    Blob.prototype.slice = function (start = 0, end = this.size, ...rest) {
      if (this.size > 3 * 1024 * 1024) window.__sliced += Math.max(0, Math.min(end, this.size) - start);
      return slice.call(this, start, end, ...rest);
    };
  });
  await openDoc(page, "big.pdf");
  await expect(page.locator("#toolbarPageCount")).toHaveText("/ 3");
  await expect(page.locator("#textLayer")).toContainText("Documento grande, pagina 1");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#textLayer")).toContainText("pagina 2");
  // Se ha leído por trozos, y bastante menos que el archivo entero.
  const sliced = await page.evaluate(() => window.__sliced);
  expect(sliced).toBeGreaterThan(0);
  expect(sliced).toBeLessThan(size * 0.6);
});

test("al reabrir un documento se pinta al instante la última página vista", async ({ page }) => {
  await openDoc(page, "refs.pdf");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#toolbarPage")).toHaveValue("2");
  await page.waitForTimeout(3200);
  const stored = await page.evaluate(async () => {
    const cache = await caches.open("paper-snapshots");
    const [request] = await cache.keys();
    const response = request && (await cache.match(request));
    return response ? { page: response.headers.get("X-Page"), type: response.headers.get("Content-Type"), size: (await response.blob()).size } : null;
  });
  expect(stored).toMatchObject({ page: "2", type: "image/jpeg" });
  expect(stored.size).toBeGreaterThan(2000);
  // Al volver a abrir la app (con el motor PDF aún descargándose) la página
  // guardada aparece enseguida y luego la sustituye la de verdad.
  await page.route(/pdf\.min\.mjs/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });
  await page.reload();
  await expect(page.locator("#canvasWrap")).toHaveClass(/is-snapshot/, { timeout: 1200 });
  await expect(page.locator("#textLayer")).not.toBeEmpty();
  await expect(page.locator("#canvasWrap")).not.toHaveClass(/is-snapshot/);
});
