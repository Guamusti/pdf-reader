import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { offlineCdn, FIXTURES } from "./helpers.mjs";

// Formularios XFA dinámicos: los que en otros visores solo muestran
// «Please wait… your PDF viewer may not be able to display this document».
test.use({ viewport: { width: 1300, height: 900 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
async function openForm(page) {
  await page.goto("/");
  await page.waitForSelector("#fileInput", { state: "attached" });
  await page.setInputFiles("#fileInput", `${FIXTURES}/xfa.pdf`);
  await page.waitForSelector("#canvasWrap .xfa-host .xfaLayer input");
}

test("se ve el formulario (no el aviso), se rellena, se recuerda y se exporta con los datos", async ({ page }) => {
  await openForm(page);
  const form = page.locator("#canvasWrap .xfa-host");
  await expect(form).toContainText("Solicitud de prueba XFA");
  await expect(form).toContainText("Acepto las condiciones");
  await expect(page.locator("#canvasWrap")).not.toContainText("Please wait");
  await expect(page.locator("#toolbarPageCount")).toHaveText("/ 2");
  // Sin capa de texto superpuesta ni oferta de OCR.
  await expect(page.locator("#textLayer span")).toHaveCount(0);
  await expect(page.locator("#ocrChip")).toBeHidden();

  // Rellenar: el campo se puede escribir y el valor se recuerda al volver.
  const name = form.locator("input").first();
  await name.click();
  await page.keyboard.type("Ana García");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector("#canvasWrap .xfa-host .xfaLayer input");
  await expect(page.locator("#canvasWrap .xfa-host input").first()).toHaveValue("Ana García");

  // Segunda página en scroll continuo.
  await page.evaluate(() => document.querySelector('[data-view-mode="continuous"]').click());
  await expect(page.locator('#continuousView .cont-page[data-page="2"] .xfa-host')).toContainText("Anexo segunda página", { timeout: 15000 });

  // Exportar: «Guardar formulario» descarga el PDF con los datos dentro.
  await page.click("#mobileMoreBtn");
  await expect(page.locator('[data-mm="pdf"]')).toContainText("Guardar formulario");
  await page.click('[data-mm="pdf"]');
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-choose="xfa"]')]);
  expect(download.suggestedFilename()).toBe("xfa-rellenado.pdf");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(await download.path())), enableXfa: true, verbosity: 0 }).promise;
  expect(doc.isPureXfa).toBe(true);
  expect(JSON.stringify(await (await doc.getPage(1)).getXfa())).toContain("Ana García");
});

test("en la biblioteca, portada de formulario (no la página «Please wait»)", async ({ page }) => {
  await openForm(page);
  await page.waitForTimeout(1500);
  await page.click("#homeBtn");
  const cover = page.locator("#library .lib-book .lib-cover").first();
  await expect(cover).toHaveClass(/is-form/);
  await expect(cover).not.toHaveClass(/has-image/);
  await expect(cover.locator(".lib-badge")).toHaveText("FORM");
});

test("con la pluma activa se dibuja encima del formulario", async ({ page }) => {
  await openForm(page);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".xfa-host")).pointerEvents)).not.toBe("none");
  await page.evaluate(() => document.body.classList.add("ink-drawing-mode"));
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".xfa-host input")).pointerEvents)).toBe("none");
});
