import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
  await context.addInitScript(() => {
    window.__pdfReads = 0;
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === "pdfs") window.__pdfReads++;
      return getAll.apply(this, args);
    };
  });
});

test("la biblioteca y Markdown funcionan sin descargar el motor PDF", async ({ page, context }) => {
  let requests = 0;
  await context.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\//, (route) => {
    requests++;
    return route.abort();
  });
  await page.goto("/");
  await page.click("#emptyLibraryBtn");
  await expect(page.locator("#library")).toContainText("Tu biblioteca está vacía");
  await page.setInputFiles("#fileInput", {
    name: "apuntes.md", mimeType: "text/markdown", buffer: Buffer.from("# Apuntes locales\n\nLectura sin esperar al motor PDF."),
  });
  await expect(page.locator("#docTitle")).toHaveText("apuntes.md");
  await expect(page.locator("#loader")).not.toHaveClass(/show/);
  await page.reload();
  await expect(page.locator("#docTitle")).toHaveText("apuntes.md");
  expect(requests).toBe(0);
});

test("reanudar una biblioteca grande no construye tarjetas ocultas ni la lee tres veces", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("paper-reader-db");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction("pdfs", "readwrite");
    const store = tx.objectStore("pdfs");
    const request = store.getAll();
    request.onsuccess = () => {
      const source = request.result[0];
      for (let i = 0; i < 80; i++) store.put({ ...source, id: `sha256:${i.toString(16).padStart(64, "0")}`, name: `Libro ${i}.pdf`, openedAt: 1 });
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator("#docTitle")).toHaveText("paper.pdf");
  await expect(page.locator("#loader")).not.toHaveClass(/show/);
  await expect(page.locator("#pdfCanvas")).toBeVisible();
  expect(await page.evaluate(() => window.__pdfReads)).toBe(1);
  await expect(page.locator(".lib-book")).toHaveCount(0);
  await page.click("#homeBtn");
  await expect(page.locator(".lib-book")).toHaveCount(81);
  const before = await page.evaluate(() => window.__pdfReads);
  await page.locator("#librarySearch").evaluate((input) => {
    for (const value of ["L", "Li", "Lib", "Libro 79"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(page.locator(".lib-book")).toHaveCount(1);
  await expect(page.locator(".lib-name")).toHaveText("Libro 79");
  expect(await page.evaluate(() => window.__pdfReads) - before).toBe(1);
});
