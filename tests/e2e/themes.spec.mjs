import { test, expect, devices } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
const setRange = (page, name, value) =>
  page.evaluate(([name, value]) => {
    const input = document.querySelector(`#themeSheet [data-ts-range="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, [name, value]);
const readerStyle = (page, selector = "#reflowReader") =>
  page.evaluate((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return { size: style.fontSize, family: style.fontFamily, weight: style.fontWeight, line: style.lineHeight, words: style.wordSpacing, theme: document.querySelector(selector).dataset.readerTheme };
  }, selector);

test.describe("escritorio", () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test("temas, ajustes con vista previa y que se recuerdan", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await page.click("#appearanceBtn");
    await page.click("#openThemeSheet");
    const sheet = page.locator("#themeSheet");
    await expect(sheet).toBeVisible();
    // En un PDF: la vista previa es la página, y el tema cambia su color.
    await expect(page.locator("#themePreview .ts-page canvas")).toBeVisible();
    await expect(page.locator("#themePdfNote")).toBeVisible();
    await page.click('[data-ts-preset="focus"]');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.pageTone)).toBe("night");
    await expect(page.locator('[data-ts-preset="focus"]')).toHaveAttribute("aria-checked", "true");

    // Modo lectura: la vista previa muestra el propio texto del documento.
    await page.click("[data-ts-reflow]");
    await expect(page.locator("#themePreview .ts-sample")).toBeVisible();
    // Sin nada guardado: los valores predeterminados, no los mínimos.
    await expect(page.locator("[data-ts-output=size]")).toHaveText("20 px");
    await expect(page.locator("[data-ts-output=leading]")).toHaveText("1.65");
    expect((await readerStyle(page)).size).toBe("20px");
    await expect(page.locator("#themePreview .ts-sample")).toContainText(/Representations|Theorem/);
    await page.click('[data-ts-preset="calm"]');
    let reader = await readerStyle(page);
    expect(reader.theme).toBe("sepia");
    expect(reader.family).toContain("Palatino");
    expect((await readerStyle(page, "#themePreview .ts-sample")).family).toContain("Palatino");
    expect(await page.evaluate(() => document.documentElement.dataset.pageTone)).toBe("sepia");

    await setRange(page, "size", 26);
    await page.click('[data-ts-toggle="bold"]');
    await setRange(page, "leading", 2);
    await setRange(page, "word", 0.2);
    reader = await readerStyle(page);
    expect(reader.size).toBe("26px");
    expect(reader.weight).toBe("600");
    expect(reader.line).toBe("52px");
    expect(reader.words).toBe("5.2px");
    // La vista previa sigue los cambios (a escala).
    expect((await readerStyle(page, "#themePreview .ts-sample")).size).toBe("20.8px");
    await expect(page.locator("[data-ts-output=size]")).toHaveText("26 px");
    // Al personalizar, ya no está marcado ningún tema predefinido.
    await expect(page.locator('[data-ts-preset][aria-checked="true"]')).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector("#reflowReader:not([hidden]) p");
    reader = await readerStyle(page);
    expect(reader.size).toBe("26px");
    expect(reader.family).toContain("Palatino");
    expect(reader.weight).toBe("600");
  });
});

test.describe("móvil", () => {
  const { defaultBrowserType, ...pixel7 } = devices["Pixel 7"];
  test.use({ ...pixel7, viewport: { width: 390, height: 844 } });

  test("desde «Más», como hoja inferior", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await page.click("#mobileMoreBtn");
    await page.click('[data-mm="themes"]');
    const card = page.locator("#themeSheet .ts-card");
    await expect(card).toBeVisible();
    await page.waitForTimeout(300);
    const box = await card.boundingBox();
    expect(Math.round(box.y + box.height)).toBe(844);
    expect(Math.round(box.width)).toBe(390);
  });
});
