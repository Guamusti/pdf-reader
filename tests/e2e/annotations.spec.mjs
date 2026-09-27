import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { offlineCdn, openDoc, drag, stylus, wordRect, selectInkTool } from "./helpers.mjs";

test.use({ viewport: { width: 1200, height: 850 }, hasTouch: true });

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

const selectWord = async (page, scope, word) => {
  const r = await wordRect(page, scope, word);
  expect(r).not.toBeNull();
  await drag(page, r.x + 1, r.y + r.height / 2, r.x + r.width - 1, r.y + r.height / 2);
  await page.waitForTimeout(250);
};
const goTo = async (page, n) => {
  await page.evaluate((n) => { const input = document.getElementById("pageJump"); input.value = n; input.dispatchEvent(new Event("change")); }, n);
  await page.waitForTimeout(900);
};

test("resaltar y dibujar con el lápiz en scroll continuo; el dedo desplaza", async ({ page, context }) => {
  await openDoc(page, "refs.pdf");
  await page.evaluate(() => document.querySelector('[data-view-mode="continuous"]').click());
  await page.waitForSelector('#continuousView .cont-page[data-page="2"] canvas');
  await page.evaluate(() => document.querySelector('.cont-page[data-page="2"]').scrollIntoView({ block: "center" }));
  await page.waitForTimeout(1200);
  await selectInkTool(page, "highlight");
  await selectWord(page, '.cont-page[data-page="2"]', "hook");
  await expect(page.locator('.cont-page[data-page="2"] .annotation-layer .annotation')).toHaveCount(1);

  await selectInkTool(page, "pen");
  const { pen, touch } = await stylus(context, page);
  const slot = await page.locator('.cont-page[data-page="2"]').boundingBox();
  const x = slot.x + 150,
    y = Math.min(slot.y + 250, 700);
  await pen("mousePressed", x, y);
  for (let i = 1; i <= 12; i++) await pen("mouseMoved", x + i * 10, y + Math.sin(i) * 8);
  await pen("mouseReleased", x + 120, y);
  await expect(page.locator(".cont-page .annotation-layer svg.annotation-vector")).toHaveCount(1);

  const before = await page.evaluate(() => document.getElementById("viewer").scrollTop);
  await touch("touchStart", [[x, 600, 8, 3]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[x, 600 - i * 30, 8, 3]]);
  await touch("touchEnd");
  await expect.poll(() => page.evaluate(() => document.getElementById("viewer").scrollTop)).toBeGreaterThan(before + 100);
  await expect(page.locator(".cont-page .annotation-layer svg.annotation-vector")).toHaveCount(1);
});

test("la palma no sustituye el trazo del lápiz sobre el PDF", async ({ page, context }) => {
  await openDoc(page, "paper.pdf");
  await selectInkTool(page, "pen");
  const { pen, touch } = await stylus(context, page);
  const b = await page.locator("#canvasWrap").boundingBox();
  await pen("mousePressed", b.x + 200, b.y + 500);
  for (let i = 1; i <= 10; i++) await pen("mouseMoved", b.x + 200 + i * 12, b.y + 500 + Math.sin(i) * 10);
  await touch("touchStart", [[b.x + 600, b.y + 650, 10]]);
  for (let i = 1; i <= 6; i++) {
    await touch("touchMove", [[b.x + 600 - i * 10, b.y + 650, 10]]);
    await pen("mouseMoved", b.x + 320 + i * 12, b.y + 500 + Math.sin(i) * 10);
  }
  await touch("touchEnd");
  await pen("mouseReleased", b.x + 400, b.y + 500);
  await expect(page.locator("#annotationLayer svg.annotation-vector")).toHaveCount(1);
  const points = await page.evaluate(() => document.querySelector("#annotationLayer svg.annotation-vector > path").getAttribute("d").split(/[ML]/).length - 1);
  expect(points).toBe(17);
});

test("doble página muestra las anotaciones de la página derecha", async ({ page }) => {
  await openDoc(page, "refs.pdf");
  await goTo(page, 2);
  await selectInkTool(page, "highlight");
  await selectWord(page, "#canvasWrap", "hook");
  await page.click("#markerModeBtn");
  await page.evaluate(() => document.querySelector('[data-view-mode="double"]').click());
  await page.waitForTimeout(1200);
  await goTo(page, 1);
  await expect(page.locator("#facingAnnotationLayer .annotation")).toHaveCount(1);
});

test("PDF anotado: anotaciones estándar con apariencia y la pizarra al final", async ({ page }) => {
  await openDoc(page, "refs.pdf");
  // La nota se añade desde el menú de selección, antes de entrar en modo Ink
  // (el modo Ink sigue activo aunque se oculte su barra).
  await selectWord(page, "#canvasWrap", "hook length");
  await page.click("#noteBtn");
  await page.fill("#noteText", "Longitud del gancho");
  await page.click("#saveNote");
  await selectInkTool(page, "underline");
  await selectWord(page, "#canvasWrap", "pairwise");
  await selectInkTool(page, "strike");
  await selectWord(page, "#canvasWrap", "Standard");
  await page.keyboard.press("w");
  const b = await page.locator("#boardLive").boundingBox();
  await page.click('[data-board-mode="pen"]');
  await drag(page, b.x + 60, b.y + 300, b.x + 260, b.y + 320, 12);
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => document.getElementById("exportAnnotatedPdf").click())]);
  expect(download.suggestedFilename()).toBe("refs-anotado.pdf");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(await download.path())) }).promise;
  expect(doc.numPages).toBe(4);
  const annotations = await (await doc.getPage(1)).getAnnotations();
  expect(annotations.map((a) => a.subtype).sort()).toEqual(["Highlight", "StrikeOut", "Underline"]);
  expect(annotations.every((a) => a.hasAppearance)).toBe(true);
  expect(annotations.find((a) => a.subtype === "Highlight").contentsObj.str).toBe("Longitud del gancho");
});
