import { test, expect, devices } from "@playwright/test";
import { offlineCdn, openDoc, wordRect } from "./helpers.mjs";

const { defaultBrowserType, ...pixel7 } = devices["Pixel 7"];

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

const goTo = async (page, n) => {
  await page.evaluate((n) => { const input = document.getElementById("pageJump"); input.value = n; input.dispatchEvent(new Event("change")); }, n);
  await page.waitForTimeout(900);
};
const previewLabel = (page) => page.locator(".hover-preview:not([hidden]) .hp-label");

test.describe("referencias matemáticas", () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test("vista previa de teorema, ecuación y sección; «Volver»", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await goTo(page, 3);
    for (const [word, label] of [["Theorem 2.3", "Teorema 2.3 · página 1"], ["(6.1)", "Ecuación (6.1) · página 1"], ["Section 3.2", "Sección 3.2 · página 2"]]) {
      await page.keyboard.press("Escape");
      const r = await wordRect(page, "#canvasWrap", word);
      await page.mouse.move(r.x + 2, r.y + r.height / 2 + 30);
      await page.mouse.move(r.x + 4, r.y + r.height / 2, { steps: 3 });
      await expect(previewLabel(page)).toHaveText(label);
    }
    await page.click(".hover-preview .hp-go");
    await expect(page.locator("#pageJump")).toHaveValue("2");
    await page.click("#returnChip");
    await expect(page.locator("#pageJump")).toHaveValue("3");
  });

  test("índice de resultados y notación", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await expect(page.locator("#structureSection")).toBeVisible();
    await expect(page.locator(".structure-item").first()).toContainText("Teorema 2.3");
    await page.click('[data-structure-tab="equations"]');
    await expect(page.locator(".structure-item").first()).toContainText("(6.1)");
    await page.click('[data-structure-tab="notation"]');
    await expect(page.locator(".structure-item").first()).toContainText("λ");
  });

  test("color de página en todas las páginas y vistas", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await expect(page.locator("[data-page-color]")).toHaveCount(8);
    await page.evaluate(() => document.querySelector('[data-page-color="sepia"]').click());
    const tint = (selector) => page.evaluate((selector) => getComputedStyle(document.querySelector(selector), "::after").backgroundColor, selector);
    expect(await tint("#canvasWrap")).toBe("rgba(196, 160, 96, 0.42)");
    await goTo(page, 2);
    expect(await tint("#canvasWrap")).toBe("rgba(196, 160, 96, 0.42)");
    await page.evaluate(() => document.querySelector('[data-view-mode="continuous"]').click());
    await page.waitForSelector("#continuousView .cont-page canvas");
    await page.evaluate(() => document.querySelector('[data-page-color="night"]').click());
    const filters = await page.evaluate(() => [...document.querySelectorAll("#continuousView .cont-page canvas")].map((canvas) => getComputedStyle(canvas).filter));
    expect(new Set(filters)).toEqual(new Set(["invert(1) hue-rotate(180deg) brightness(0.94)"]));
    // Los ajustes se escriben en disco en lotes; se espera a que se guarden.
    await page.waitForTimeout(500);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.pageTone)).toBe("night");
  });
});

test.describe("móvil", () => {
  test.use({ ...pixel7, viewport: { width: 390, height: 844 } });

  test("referencias al tocar, cabecera bajo el notch, modo inmersivo, pie contraído y menú «Más»", async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    await openDoc(page, "refs.pdf");
    expect(Math.round((await page.locator(".toolbar").boundingBox()).height)).toBe(101);

    await goTo(page, 3);
    const r = await wordRect(page, "#canvasWrap", "(6.1)");
    await page.touchscreen.tap(r.x + 4, r.y + r.height / 2);
    await expect(previewLabel(page)).toHaveText("Ecuación (6.1) · página 1");
    await page.keyboard.press("Escape");

    await page.touchscreen.tap(195, 600);
    await expect(page.locator("body")).toHaveClass(/reader-chrome-hidden/);
    await expect(page.locator(".toolbar")).toBeHidden();
    await expect(page.locator(".footer")).toBeHidden();
    await page.touchscreen.tap(195, 600);
    await expect(page.locator(".footer")).toBeVisible();

    await page.click("#footerCollapse");
    await expect(page.locator(".footer")).toHaveClass(/footer-minimized/);
    await expect(page.locator("#footerCollapse")).toContainText("3 / 3");
    expect(Math.round((await page.locator(".footer").boundingBox()).height)).toBe(40);

    await page.click("#mobileMoreBtn");
    await expect(page.locator(".mm-grid button")).toContainText(["Biblioteca", "Cuaderno", "Pizarra"]);
  });
});

test.describe("iPad", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("el menú «Más» da acceso a lo que no está en la barra (OCR, estudiar, PDF anotado…)", async ({ page }) => {
    await openDoc(page, "scan.pdf");
    await expect(page.locator("#mobileMoreBtn")).toBeVisible();
    await page.click("#mobileMoreBtn");
    const menu = page.locator("#mobileMore .mm-grid button");
    await expect(menu).toHaveText(["Estudiar", "Modo lectura", "PDF anotado", "Reconocer texto (OCR)", "Exportar notas", "Copia y sincronización", "Pantalla completa"]);
    // Desplegable bajo el botón, no hoja inferior.
    await page.waitForTimeout(250);
    const [button, sheet] = await Promise.all([page.locator("#mobileMoreBtn").boundingBox(), page.locator(".mm-sheet").boundingBox()]);
    expect(sheet.y).toBeGreaterThan(button.y + button.height);
    expect(sheet.y).toBeLessThan(button.y + button.height + 20);
    expect(Math.abs(sheet.x + sheet.width - (button.x + button.width))).toBeLessThan(2);
    await page.click('[data-mm="ocr"]');
    await expect(page.locator("#mobileMore")).toBeHidden();
    await expect(page.locator("#textLayer.ocr-layer span").first()).toBeAttached({ timeout: 60_000 });
    await expect(page.locator("#textLayer")).toContainText("Tablas de Young");
  });

  test("la barra superior no se solapa en ningún ancho de tableta", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    const problems = [];
    for (let width = 701; width <= 1440; width += 13) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(40);
      problems.push(
        ...(await page.evaluate((width) => {
          const box = (el) => el.getBoundingClientRect();
          const items = [...document.querySelectorAll(".toolbar button, .toolbar input"), document.querySelector(".toolbar-nav")].filter((el) => box(el).width > 0);
          const out = [];
          for (let i = 0; i < items.length; i++) {
            if (box(items[i]).right > innerWidth + 1) out.push(`${width}: ${items[i].id} se sale`);
            for (let j = i + 1; j < items.length; j++) {
              if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
              const a = box(items[i]), b = box(items[j]);
              if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${width}: ${items[i].id || items[i].className} ~ ${items[j].id || items[j].className}`);
            }
          }
          return out;
        }, width)),
      );
    }
    expect(problems).toEqual([]);
  });
});
