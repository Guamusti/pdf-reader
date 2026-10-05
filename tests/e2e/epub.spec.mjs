import { test, expect } from "@playwright/test";
import { offlineCdn, FIXTURES } from "./helpers.mjs";

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
async function openBook(page) {
  await page.goto("/");
  await page.waitForSelector("#fileInput", { state: "attached" });
  await page.setInputFiles("#fileInput", `${FIXTURES}/libro.epub`);
  await page.waitForSelector("#reflowReader.is-epub .epub-chapter");
  await page.waitForTimeout(400);
}
const status = (page) => page.locator("#pageStatus");

test.describe("escritorio", () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test("se abre como libro: capítulos, índice, imágenes, notas, posición y biblioteca", async ({ page }) => {
    await openBook(page);
    await expect(page.locator("#docTitle")).toHaveText("El libro de prueba");
    await expect(page.locator("#docMeta")).toContainText("Ana Autora");
    await expect(page.locator(".epub-chapter")).toHaveCount(2);
    await expect(status(page)).toContainText("Capítulo 1 de 2");
    // Sin scripts, eventos ni estilos del libro.
    expect(await page.evaluate(() => ({ script: document.querySelectorAll("#reflowReader script, #reflowReader style").length, onclick: document.querySelectorAll("#reflowReader [onclick]").length, ran: Boolean(window.__epubScript) }))).toEqual({ script: 0, onclick: 0, ran: false });
    await expect(page.locator('#reflowReader a[href="https://example.com"]')).toHaveAttribute("target", "_blank");

    // La imagen se carga al acercarse.
    await page.locator("#reflowReader figure").scrollIntoViewIfNeeded();
    await expect(page.locator("#reflowReader figure img")).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => page.locator("#reflowReader figure img").evaluate((img) => img.naturalWidth)).toBe(300);

    // Índice con la subsección.
    await page.evaluate(() => document.querySelector("#reflowReader").closest("#viewer").scrollTo(0, 0));
    await expect(page.locator("#outlineList .outline-name")).toHaveText(["Capítulo 1: El comienzo", "Capítulo 2: La travesía", "La nota"]);
    await page.click('#outlineList .outline-item:has-text("La nota")');
    await expect(status(page)).toContainText("Capítulo 2 de 2");
    await expect(status(page)).toContainText("La travesía");

    // Nota al pie: vista previa y salto.
    await page.click("#toolbarPrev");
    await expect(status(page)).toContainText("Capítulo 1 de 2");
    await page.locator('#reflowReader a[data-epub-link]').first().hover();
    await expect(page.locator(".hover-preview:not([hidden]) .hp-label")).toHaveText("Nota");
    await expect(page.locator(".hover-preview:not([hidden]) .hp-body")).toContainText("Esta es la nota al pie");

    // Siguiente capítulo y posición recordada al volver a abrirlo.
    await page.mouse.move(5, 5);
    await page.click("#toolbarNext");
    await expect(status(page)).toContainText("Capítulo 2 de 2");
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForSelector("#reflowReader.is-epub .epub-chapter");
    await expect(status(page)).toContainText("Capítulo 2 de 2");

    // Biblioteca: título, autor, capítulo, portada y filtro «Libros».
    await page.click("#homeBtn");
    const card = page.locator("#library .lib-book").first();
    await expect(card.locator(".lib-name")).toHaveText("El libro de prueba");
    await expect(card.locator(".lib-meta")).toContainText("Ana Autora · cap. 2 de 2");
    await expect(card.locator(".lib-cover")).toHaveClass(/has-image/);
    await expect(card.locator(".lib-badge")).toHaveText("EPUB");
    await expect(page.locator('[data-library-filter="epub"]')).toContainText("Libros");
  });

  test("los temas y ajustes de lectura se aplican al libro", async ({ page }) => {
    await openBook(page);
    await page.click("#mobileMoreBtn");
    await page.click('[data-mm="themes"]');
    await expect(page.locator("#themePreview .ts-sample")).toContainText("Capítulo 1");
    await page.click('[data-ts-preset="calm"]');
    const style = await page.evaluate(() => {
      const reader = document.getElementById("reflowReader");
      return { family: getComputedStyle(reader).fontFamily, theme: reader.dataset.readerTheme, color: getComputedStyle(reader.querySelector("p")).color };
    });
    expect(style.family).toContain("Palatino");
    expect(style.theme).toBe("sepia");
    // El color del CSS del libro (rojo) no se aplica.
    expect(style.color).not.toBe("rgb(255, 0, 0)");
  });
});

test.describe("iPad", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("tocar una nota muestra la vista previa; el segundo toque salta", async ({ page }) => {
    await openBook(page);
    const link = page.locator('#reflowReader a[data-epub-link]').first();
    await link.tap();
    await expect(page.locator(".hover-preview:not([hidden]) .hp-body")).toContainText("Esta es la nota al pie");
    await expect(status(page)).toContainText("Capítulo 1 de 2");
    await link.tap();
    await expect(status(page)).toContainText("Capítulo 2 de 2");
  });
});
