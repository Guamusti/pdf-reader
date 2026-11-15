import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

// Calidad de dibujo: nitidez con mucho zoom y cambios de zoom sin fogonazo.
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });

const density = (page, selector) =>
  page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    return canvas ? canvas.width / canvas.getBoundingClientRect().width : 0;
  }, selector);

test("con mucho zoom, la zona visible se repasa a la densidad de la pantalla", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  // A tamaño normal el lienzo ya es nítido: no hace falta repaso.
  expect(await density(page, "#pdfCanvas")).toBeGreaterThan(1.9);
  await page.waitForTimeout(500);
  await expect(page.locator("#canvasWrap > canvas.page-detail")).toHaveCount(0);

  for (let i = 0; i < 40 && !(await page.locator("#zoomLabel").textContent()).startsWith("500"); i++) await page.click("#zoomIn");
  await expect(page.locator("#zoomLabel")).toHaveText("500%");
  // La página entera ya no cabe a 2x…
  await expect.poll(() => density(page, "#pdfCanvas")).toBeLessThan(1.8);
  // …pero la zona visible sí se dibuja a 2x, encima y alineada.
  const detail = page.locator("#canvasWrap > canvas.page-detail");
  await expect(detail).toHaveCount(1);
  expect(await density(page, "#canvasWrap > canvas.page-detail")).toBeGreaterThan(1.9);
  const covers = () =>
    page.evaluate(() => {
      const d = document.querySelector("#canvasWrap > canvas.page-detail").getBoundingClientRect();
      const v = document.querySelector("#viewer").getBoundingClientRect();
      const w = document.querySelector("#canvasWrap").getBoundingClientRect();
      return d.left <= Math.max(v.left, w.left) + 1 && d.top <= Math.max(v.top, w.top) + 1 && d.right >= Math.min(v.right, w.right) - 1 && d.bottom >= Math.min(v.bottom, w.bottom) - 1;
    });
  expect(await covers()).toBe(true);
  // Tiene contenido (no es un lienzo en blanco) y sigue al desplazamiento.
  const inked = await page.evaluate(() => {
    const canvas = document.querySelector("#canvasWrap > canvas.page-detail");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] < 120) dark++;
    return dark;
  });
  expect(inked).toBeGreaterThan(50);
  await page.locator("#viewer").hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(covers).toBe(true);
});

test("al cambiar el zoom el lienzo nunca se queda en blanco", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  await page.evaluate(() => {
    window.__blank = 0;
    const canvas = document.querySelector("#pdfCanvas");
    const check = () => {
      const context = canvas.getContext("2d");
      const x = Math.floor(canvas.width / 2);
      const sample = canvas.width ? context.getImageData(0, 0, canvas.width, 1).data : null;
      let painted = false;
      if (sample) for (let i = 3; i < sample.length; i += 4) if (sample[i]) { painted = true; break; }
      if (!painted) window.__blank++;
      window.__raf = requestAnimationFrame(check);
    };
    check();
  });
  for (let i = 0; i < 4; i++) {
    await page.click("#zoomIn");
    await page.waitForTimeout(250);
  }
  expect(await page.evaluate(() => window.__blank)).toBe(0);
});
