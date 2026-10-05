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

test.describe("colores y tipografías", () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test("cada «Aa» se ve con su tipografía", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await page.click("#appearanceBtn");
    await page.click("#openThemeSheet");
    const families = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".ts-fonts [data-font-sample]")].map((node) => [node.dataset.fontSample, getComputedStyle(node).fontFamily])));
    expect(Object.keys(families)).toHaveLength(12);
    expect(families.serif).toMatch(/^Charter/);
    expect(families.palatino).toMatch(/^Palatino/);
    expect(families.iowan).toMatch(/^"Iowan Old Style"/);
    expect(families.mono).toMatch(/^"SF Mono"/);
    expect(new Set(Object.values(families)).size).toBe(12);
    // También en los temas predefinidos.
    expect(await page.locator('[data-ts-preset="calm"] [data-font-sample]').evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/^Palatino/);
  });

  test("un solo color de página para el PDF y el Modo lectura, y color personalizado", async ({ page }) => {
    await openDoc(page, "refs.pdf");
    await page.click("#appearanceBtn");
    await page.click("#openThemeSheet");
    await page.click("[data-ts-reflow]");
    // «Noche cálida» también en el Modo lectura.
    await page.click('.ts-tones [data-page-color="night-warm"]');
    let reader = await page.evaluate(() => { const r = document.getElementById("reflowReader"); return { theme: r.dataset.readerTheme, bg: getComputedStyle(r).backgroundColor, dark: r.hasAttribute("data-reader-dark") }; });
    expect(reader).toEqual({ theme: "night-warm", bg: "rgb(23, 19, 13)", dark: true });
    expect(await page.evaluate(() => document.documentElement.dataset.pageTone)).toBe("night-warm");

    // Personalizado: fondo y texto a elegir.
    await expect(page.locator("#themeCustom")).toBeHidden();
    await page.click('.ts-tones [data-page-color="custom"]');
    await expect(page.locator("#themeCustom")).toBeVisible();
    const pick = (part, value) => page.evaluate(([part, value]) => {
      const input = document.querySelector(`[data-ts-color="${part}"]`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, [part, value]);
    await pick("bg", "#f0e4ff");
    await pick("fg", "#3a1d5c");
    reader = await page.evaluate(() => { const r = document.getElementById("reflowReader"); return { bg: getComputedStyle(r).backgroundColor, color: getComputedStyle(r).color, dark: r.hasAttribute("data-reader-dark") }; });
    expect(reader).toEqual({ bg: "rgb(240, 228, 255)", color: "rgb(58, 29, 92)", dark: false });
    await expect(page.locator('[data-ts-color-value="bg"]')).toHaveText("#F0E4FF");
    expect((await page.evaluate(() => getComputedStyle(document.querySelector("#themePreview .ts-sample")).backgroundColor))).toBe("rgb(240, 228, 255)");

    // En el PDF: claro tiñe el papel; oscuro invierte la página con ese fondo.
    await page.keyboard.press("Escape");
    await page.click("#appearanceBtn");
    await page.click('[data-reading-mode="pdf"]');
    await page.waitForSelector("#canvasWrap:not([hidden]) canvas");
    const tint = () => page.evaluate(() => ({ tint: getComputedStyle(document.querySelector("#canvasWrap"), "::after").backgroundColor, filter: getComputedStyle(document.querySelector("#canvasWrap canvas")).filter }));
    expect(await tint()).toEqual({ tint: "rgb(240, 228, 255)", filter: "none" });
    await page.click("#openThemeSheet");
    await pick("bg", "#102030");
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-page-dark"))).toBe(true);
    const dark = await tint();
    expect(dark.filter).toContain("invert(1)");
    expect(dark.tint).toBe("rgb(16, 32, 48)");

    // Se recuerda al volver a abrir.
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector("#canvasWrap:not([hidden]) canvas");
    expect(await page.evaluate(() => [document.documentElement.dataset.pageTone, getComputedStyle(document.documentElement).getPropertyValue("--custom-page-color").trim()])).toEqual(["custom", "#102030"]);
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
