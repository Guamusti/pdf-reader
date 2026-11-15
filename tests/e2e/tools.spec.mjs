import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { offlineCdn, openDoc, FIXTURES } from "./helpers.mjs";

// Imprimir, extraer páginas y unir PDFs.
test.use({ viewport: { width: 1300, height: 900 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
const pageCount = async (path) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return (await pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), verbosity: 0 }).promise).numPages;
};

test("extraer páginas: rango, descarga y copia en la biblioteca", async ({ page }) => {
  await openDoc(page, "links.pdf");
  await page.click("#appearanceBtn");
  await page.click("#extractPagesBtn");
  const input = page.locator(".lib-dialog input");
  await expect(input).toHaveValue("1");
  // Un rango imposible se explica y no hace nada.
  await input.fill("2-9");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast, #toast").first()).toContainText("No entiendo");

  await page.click("#appearanceBtn");
  await page.click("#extractPagesBtn");
  await page.locator(".lib-dialog input").fill("3, 1");
  await page.keyboard.press("Enter");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-choose="download"]')]);
  expect(download.suggestedFilename()).toBe("links (p3-1).pdf");
  expect(await pageCount(await download.path())).toBe(2);

  await page.click("#appearanceBtn");
  await page.click("#extractPagesBtn");
  await page.locator(".lib-dialog input").fill("2-");
  await page.keyboard.press("Enter");
  await page.click('[data-choose="library"]');
  await page.click("#homeBtn");
  const copy = page.locator("#library .lib-book").filter({ hasText: "links (p2-3)" });
  await expect(copy).toHaveCount(1);
  await expect(copy).toContainText("de 2");
});

test("unir dos PDFs de la biblioteca", async ({ page }) => {
  await openDoc(page, "links.pdf");
  await page.setInputFiles("#fileInput", [`${FIXTURES}/paper.pdf`]);
  await expect(page.locator("#docTitle")).toContainText(/paper/i);
  await page.click("#homeBtn");
  const card = page.locator("#library .lib-book").filter({ hasText: "links" });
  await card.hover();
  await card.locator("[data-move-book]").click();
  await page.locator("#libraryMenu button", { hasText: "Unir a continuación" }).click();
  const merged = page.locator("#library .lib-book").filter({ hasText: "paper + links" });
  await expect(merged).toHaveCount(1);
  await merged.locator(".lib-open").click();
  await expect(page.locator("#toolbarPageCount")).toHaveText("/ 4");
});

test("imprimir abre el diálogo del sistema con el PDF", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  await page.click("#appearanceBtn");
  await page.click("#printBtn");
  const frame = page.locator("#printFrame");
  await expect(frame).toHaveCount(1);
  expect(await frame.getAttribute("src")).toMatch(/^blob:/);
  const bytes = await page.evaluate(async () => {
    const data = new Uint8Array(await (await fetch(document.querySelector("#printFrame").src)).arrayBuffer());
    return { length: data.length, head: String.fromCharCode(...data.slice(0, 5)) };
  });
  expect(bytes.head).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);
});
