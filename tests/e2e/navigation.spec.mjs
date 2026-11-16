import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

// Dónde está cada cosa: «Buscar» (Ctrl F) y «Acciones» (Ctrl K) por separado,
// y un menú «⋯» con todas las funciones.
test.use({ viewport: { width: 1400, height: 850 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
const groups = (page) => page.locator("#paletteList .palette-group");
const tab = (page, mode) => page.locator(`[data-palette-mode="${mode}"]`);

test("Ctrl F busca en el documento y Ctrl K lista acciones, sin mezclarse", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  // El campo de la barra y Ctrl F abren «Buscar».
  await page.click("#paletteBtn");
  await expect(tab(page, "search")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("hook");
  await expect(groups(page).first()).toHaveText("En este documento");
  await expect(page.locator("#paletteList")).not.toContainText("Imprimir");
  // «girar» no está en el texto: se avisa de que hay acciones con ese nombre.
  await page.locator("#paletteInput").fill("girar");
  await expect(page.locator("#paletteList")).toContainText("acción coincide");
  await page.keyboard.press("Enter");
  await expect(tab(page, "actions")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#paletteList")).toContainText("Girar página");
  await page.keyboard.press("Escape");

  // Ctrl K: el catálogo de acciones por temas, sin resultados de texto.
  await page.keyboard.press("Control+k");
  await expect(tab(page, "actions")).toHaveAttribute("aria-selected", "true");
  await expect(groups(page)).toHaveText(["Asistente IA", "Documento", "Anotar y estudiar", "Vista", "Navegar", "Herramientas"]);
  await expect(page.locator(".palette-opts")).toBeHidden();
  await page.keyboard.type("hook");
  await expect(page.locator("#paletteList")).not.toContainText("Página 1");
  await expect(page.locator("#paletteList")).toContainText("Buscar «hook» en el documento");
  // Tab cambia de pestaña y conserva lo escrito.
  await page.keyboard.press("Tab");
  await expect(tab(page, "search")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#paletteInput")).toHaveValue("hook");
  await expect(page.locator("#paletteList")).toContainText("Página 1");
  // Ctrl K con la paleta abierta pasa a «Acciones»; otra vez, la cierra.
  await page.keyboard.press("Control+k");
  await expect(tab(page, "actions")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+k");
  await expect(page.locator("#palette")).toBeHidden();
});

test("el menú «⋯» tiene todas las funciones, con atajos, y cabe en pantalla", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  // En un portátil los accesos principales llevan nombre.
  for (const [id, label] of [["captureBtn", "Asistente"], ["markerModeBtn", "Anotar"], ["appearanceBtn", "Vista"]]) await expect(page.locator(`#${id} .btn-label`)).toBeVisible();
  await expect(page.locator("#markerModeBtn")).toContainText("Anotar");
  await page.click("#mobileMoreBtn");
  const sheet = page.locator(".mm-sheet");
  await expect(page.locator("#mobileMore .mm-title")).toHaveText(["Documento", "Vista", "Anotar", "Estudiar e IA", "Herramientas", "Paper Reader"]);
  expect(await page.locator("#mobileMore [data-mm]").count()).toBeGreaterThan(28);
  await expect(page.locator('[data-mm="rotate"] kbd')).toHaveText("R");
  // Ningún nombre queda cortado y el menú no se sale de la ventana.
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => {
    const box = document.querySelector(".mm-sheet").getBoundingClientRect();
    const clipped = [...document.querySelectorAll("#mobileMore [data-mm] > span")].filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent);
    return { clipped, inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  });
  expect(state.clipped).toEqual([]);
  expect(state.inside).toBe(true);
  // Funciones que antes solo estaban en Ctrl K.
  await page.click('[data-mm="shortcuts"]');
  await expect(page.locator("#shortcutsPanel")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.click("#mobileMoreBtn");
  await page.click('[data-mm="actions"]');
  await expect(tab(page, "actions")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await page.click("#mobileMoreBtn");
  await page.click('[data-mm="thumbs"]');
  await expect(page.locator("#thumbnailRail")).toBeVisible();
});

test("el tema se cambia desde Vista, la biblioteca y el menú; «Automático» sigue al sistema", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openDoc(page, "paper.pdf");
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  expect(await theme()).toBe("light");
  // Menú Vista.
  await page.click("#appearanceBtn");
  await page.click('#viewThemeSwitch [data-app-theme="dark"]');
  expect(await theme()).toBe("dark");
  await page.click('#viewThemeSwitch [data-app-theme="auto"]');
  expect(await theme()).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");
  await page.keyboard.press("Escape");
  // Biblioteca.
  await page.click("#homeBtn");
  await page.click("#libraryThemeBtn");
  await expect(page.locator("#libraryMenu button.is-checked")).toHaveText("Automático");
  await page.locator("#libraryMenu button", { hasText: "Sepia" }).click();
  expect(await theme()).toBe("sepia");
  // Se recuerda al recargar.
  await page.waitForTimeout(800);
  await page.reload();
  await expect.poll(theme).toBe("sepia");
});
