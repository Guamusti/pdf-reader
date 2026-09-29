import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc, FIXTURES } from "./helpers.mjs";

test.use({ viewport: { width: 1300, height: 900 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

const tiles = (page) => page.locator("#library .lib-folder .lib-name");
const books = (page) => page.locator("#library .lib-book .lib-name");
const crumbs = (page) => page.locator("#libraryPath .lib-crumb span");
async function newFolder(page, name) {
  await page.click("[data-folder-new]");
  await page.locator(".lib-dialog input").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.locator(".lib-dialog")).toHaveCount(0);
}
async function moveBook(page, book, target) {
  const card = page.locator("#library .lib-book").filter({ hasText: book });
  await card.hover();
  await card.locator("[data-move-book]").click();
  await page.locator("#libraryMenu button", { hasText: target }).click();
}

test("carpetas: crear, mover, subcarpetas, arrastrar, buscar, recargar y eliminar", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  await page.setInputFiles("#fileInput", [`${FIXTURES}/refs.pdf`, `${FIXTURES}/links.pdf`]);
  await page.waitForTimeout(800);
  await page.click("#homeBtn");
  await expect(books(page)).toHaveCount(3);

  await newFolder(page, "Álgebra");
  await expect(tiles(page)).toHaveText(["Álgebra"]);
  await moveBook(page, "refs", "Álgebra");
  await expect(books(page)).toHaveCount(2);
  await expect(page.locator(".lib-folder .lib-meta")).toHaveText("1 documento");

  // Dentro de la carpeta: ruta, su documento y una subcarpeta.
  await page.click('.lib-folder [data-folder-open]');
  await expect(crumbs(page)).toHaveText(["Biblioteca", "Álgebra"]);
  await expect(books(page)).toHaveCount(1);
  await newFolder(page, "Grupos");
  await expect(tiles(page)).toHaveText(["Grupos"]);
  // Arrastrar el documento hasta la subcarpeta.
  await page.locator("#library .lib-book").first().dragTo(page.locator('.lib-folder[data-folder-drop]').first());
  await expect(books(page)).toHaveCount(0);
  await expect(page.locator(".lib-folder .lib-meta")).toHaveText("1 documento");

  // Al buscar desde la raíz se ve dónde está cada documento.
  await page.click('.lib-crumb[data-folder-open=""]');
  await expect(tiles(page)).toHaveText(["Álgebra"]);
  await expect(page.locator(".lib-folder .lib-meta")).toHaveText("1 documento · 1 carpeta");
  await page.fill("#librarySearch", "refs");
  await expect(books(page)).toHaveCount(1);
  await expect(page.locator(".lib-book .lib-where")).toHaveText("Álgebra › Grupos");
  await page.fill("#librarySearch", "");

  // Se conserva al recargar, y la biblioteca vuelve a la carpeta abierta.
  await page.click('.lib-folder [data-folder-open]');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector("#homeBtn");
  await page.waitForTimeout(800);
  await page.click("#homeBtn");
  await expect(crumbs(page)).toHaveText(["Biblioteca", "Álgebra"]);
  await expect(tiles(page)).toHaveText(["Grupos"]);

  // Un documento añadido estando en una carpeta se queda en ella.
  await page.click('.lib-folder [data-folder-open]');
  await expect(crumbs(page)).toHaveText(["Biblioteca", "Álgebra", "Grupos"]);
  await page.setInputFiles("#fileInput", `${FIXTURES}/scan.pdf`);
  await page.waitForTimeout(1000);
  if (await page.locator("#libraryPanel").isHidden()) await page.click("#homeBtn");
  await expect(books(page)).toHaveCount(2);

  // Renombrar y eliminar: los documentos no se borran, suben de nivel.
  await page.click('.lib-crumb[data-folder-open=""]');
  const folder = page.locator(".lib-folder").first();
  await folder.hover();
  await folder.locator("[data-folder-menu]").click();
  await page.locator("#libraryMenu button", { hasText: "Renombrar" }).click();
  await page.locator(".lib-dialog input").fill("Álgebra II");
  await page.keyboard.press("Enter");
  await expect(tiles(page)).toHaveText(["Álgebra II"]);
  page.once("dialog", (dialog) => dialog.accept());
  await folder.hover();
  await folder.locator("[data-folder-menu]").click();
  await page.locator("#libraryMenu button", { hasText: "Eliminar carpeta" }).click();
  await expect(tiles(page)).toHaveText(["Grupos"]);
  await expect(books(page)).toHaveCount(2);
  await page.click('.lib-folder [data-folder-open]');
  await expect(books(page)).toHaveCount(2);
});

test.describe("iPad", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("con el dedo: botón de mover visible y menú de carpetas", async ({ page }) => {
    await openDoc(page, "paper.pdf");
    await page.click("#homeBtn");
    await newFolder(page, "Lecturas");
    const move = page.locator(".lib-book [data-move-book]").first();
    await expect(move).toBeVisible();
    expect(Number(await move.evaluate((node) => getComputedStyle(node).opacity))).toBeGreaterThan(0.5);
    await move.tap();
    await page.locator("#libraryMenu button", { hasText: "Nueva carpeta" }).tap();
    await page.locator(".lib-dialog input").fill("Pendientes");
    await page.locator(".lib-dialog .is-primary").tap();
    await expect(tiles(page)).toHaveText(["Lecturas", "Pendientes"]);
    await expect(books(page)).toHaveCount(0);
  });
});
