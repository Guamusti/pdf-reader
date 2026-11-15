import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { offlineCdn, openDoc } from "./helpers.mjs";

// Formularios rellenables normales (AcroForm): campos de verdad sobre la
// página, valores recordados y exportados dentro del PDF.
test.use({ viewport: { width: 1300, height: 900 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

test("se rellena, se recuerda al volver y se exporta con los datos", async ({ page }) => {
  await openDoc(page, "acroform.pdf");
  const form = page.locator("#canvasWrap .form-host");
  const name = form.locator('input[type="text"]');
  await expect(name).toBeVisible();
  // El campo queda donde lo dibuja el PDF (junto a su etiqueta).
  const wrap = await page.locator("#canvasWrap").boundingBox();
  const box = await name.boundingBox();
  expect((box.x - wrap.x) / wrap.width).toBeGreaterThan(0.2);
  expect((box.x - wrap.x) / wrap.width).toBeLessThan(0.24);
  expect((box.y - wrap.y) / wrap.height).toBeGreaterThan(0.1);
  expect((box.y - wrap.y) / wrap.height).toBeLessThan(0.16);
  expect(box.width / wrap.width).toBeGreaterThan(0.4);

  await name.click();
  await page.keyboard.type("Ana García");
  await form.locator('input[type="checkbox"]').check();
  await form.locator("select").selectOption("Sevilla");
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('#canvasWrap .form-host input[type="text"]')).toHaveValue("Ana García");
  await expect(page.locator('#canvasWrap .form-host input[type="checkbox"]')).toBeChecked();
  await expect(page.locator("#canvasWrap .form-host select")).toHaveValue("Sevilla");

  // Con zoom y en scroll continuo los campos siguen en su sitio.
  await page.evaluate(() => document.querySelector('[data-view-mode="continuous"]').click());
  await expect(page.locator('#continuousView .cont-page[data-page="1"] .form-host input[type="text"]')).toHaveValue("Ana García");

  // Exportar: los datos van dentro del propio PDF.
  await page.click("#mobileMoreBtn");
  await expect(page.locator('[data-mm="pdf"]')).toContainText("Guardar formulario");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-mm="pdf"]')]);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(await download.path())), verbosity: 0 }).promise;
  const fields = await doc.getFieldObjects();
  const value = (name) => fields[name].find((field) => field.value !== undefined).value;
  expect(download.suggestedFilename()).toBe("acroform-rellenado.pdf");
  expect(value("nombre")).toBe("Ana García");
  expect(value("provincia")).toBe("Sevilla");
  expect(value("acepto")).toBe("Yes");
});
