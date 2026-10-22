// Interfaz en el móvil: nada tapa la barra superior ni queda fuera de la
// pantalla o bajo el notch.
import { test, expect, devices } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

const { defaultBrowserType, ...iphone } = devices["iPhone 13"];

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

async function notch(context, page, insets = { top: 47, bottom: 34, left: 0, right: 0 }) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
}
const box = (page, selector) => page.locator(selector).first().boundingBox();

test.describe("iPhone", () => {
  test.use({ ...iphone });

  test("la barra Ink va abajo, no tapa la cabecera y se cierra con «Listo»", async ({ page, context }) => {
    await notch(context, page);
    await openDoc(page, "refs.pdf");
    const toolbar = await box(page, ".toolbar");
    await page.click("#markerModeBtn");
    await expect(page.locator("#inkStrip")).toBeVisible();
    const strip = await box(page, "#inkStrip");
    expect(strip.y).toBeGreaterThan(toolbar.y + toolbar.height);
    expect(strip.y + strip.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    // El pie de páginas se aparta mientras está la barra Ink.
    await expect(page.locator(".footer")).toBeHidden();
    const done = await box(page, "[data-strip-close]");
    expect(done.x + done.width).toBeLessThanOrEqual(page.viewportSize().width);
    // La cabecera sigue siendo usable: el mismo botón la cierra.
    await page.click("#markerModeBtn");
    await expect(page.locator("#inkStrip")).toBeHidden();
    await page.click("#markerModeBtn");
    await page.click("[data-strip-close]");
    await expect(page.locator("#inkStrip")).toBeHidden();
    await expect(page.locator(".footer")).toBeVisible();
  });

  test("«Vista» es una hoja inferior bajo la cabecera, con fondo, y Escape la cierra", async ({ page, context }) => {
    await notch(context, page);
    await openDoc(page, "refs.pdf");
    const toolbar = await box(page, ".toolbar");
    await page.click("#appearanceBtn");
    const sheet = await box(page, "#appearancePopover");
    expect(sheet.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
    expect(Math.round(sheet.y + sheet.height)).toBe(page.viewportSize().height);
    await expect(page.locator("#splitViewBtn")).toBeHidden();
    await expect(page.locator(".footer")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("#appearancePopover")).not.toHaveClass(/\bopen\b/);
  });

  test("el panel lateral, el buscador y la biblioteca empiezan bajo el notch", async ({ page, context }) => {
    await notch(context, page);
    await openDoc(page, "refs.pdf");
    await page.click("#openSidebar");
    expect((await box(page, ".sidebar .brand")).y).toBeGreaterThanOrEqual(47);
    await page.evaluate(() => document.body.classList.remove("sidebar-open"));
    await page.click("#paletteBtn");
    // La tarjeta entra con una animación: se mide al terminar.
    await expect.poll(async () => (await box(page, ".palette-card")).y).toBeGreaterThanOrEqual(47);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.getElementById("homeBtn").click());
    expect((await box(page, "#libraryTitle")).y).toBeGreaterThanOrEqual(47);
  });
});

test.describe("iPhone en horizontal", () => {
  const { defaultBrowserType: _, ...landscape } = devices["iPhone 13 landscape"];
  test.use({ ...landscape });

  test("la cabecera no repite el selector de páginas y el título se lee", async ({ page, context }) => {
    await notch(context, page, { top: 0, bottom: 21, left: 47, right: 47 });
    await openDoc(page, "refs.pdf");
    await expect(page.locator(".toolbar .toolbar-nav")).toBeHidden();
    expect((await box(page, "#docTitle")).width).toBeGreaterThan(60);
  });
});
