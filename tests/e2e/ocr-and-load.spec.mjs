import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc, drag, selectInkTool } from "./helpers.mjs";

test.use({ viewport: { width: 1300, height: 900 } });

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

test("OCR de una página escaneada: texto seleccionable, resaltable y buscable", async ({ page }) => {
  await openDoc(page, "scan.pdf");
  const chip = page.locator("#ocrChip");
  await expect(chip).toContainText("Página escaneada");
  await page.click('[data-ocr="page"]');
  await expect(page.locator("#textLayer.ocr-layer span").first()).toBeAttached({ timeout: 60_000 });
  await expect(page.locator("#textLayer")).toContainText("Tablas de Young");
  await expect(chip).toBeHidden();

  await selectInkTool(page, "highlight");
  const r = await page.evaluate(() => [...document.querySelectorAll("#textLayer span")].find((span) => /divided/.test(span.textContent)).getBoundingClientRect().toJSON());
  await drag(page, r.x + 1, r.y + r.height / 2, r.x + r.width - 2, r.y + r.height / 2);
  await expect(page.locator("#annotationLayer .annotation")).toHaveCount(1);

  await page.click("#markerModeBtn");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Young");
  await expect(page.locator("#paletteList")).toContainText("Tablas de Young");
});

test.describe("service worker", () => {
  test.use({ serviceWorkers: "allow" });

test("instalada, la app arranca al instante aunque la red tarde", async ({ page, context }) => {
  await page.goto("/");
  // El service worker se instala y guarda la app.
  await page.waitForFunction(() => navigator.serviceWorker?.controller || new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve)), null, { timeout: 20_000 });
  await page.reload();
  await page.waitForTimeout(800);
  // Mala cobertura: el HTML tarda 3 s en llegar.
  await context.route((url) => url.pathname === "/" || url.pathname === "/index.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const fcp = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const entry = performance.getEntriesByName("first-contentful-paint")[0];
        if (entry) resolve(entry.startTime);
        else new PerformanceObserver((list) => resolve(list.getEntries()[0].startTime)).observe({ type: "paint", buffered: true });
      }),
  );
  expect(fcp).toBeLessThan(1500);
});
});
