import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc, FIXTURES } from "./helpers.mjs";

// Dos PDFs a la vez, uno a cada lado, con el ancho ajustable.
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
test.use({ viewport: { width: 1300, height: 860 } });

const splitWidth = (page) => page.evaluate(() => document.querySelector("#splitPane").getBoundingClientRect().width);

test("abrir otro PDF al lado, ajustar el ancho, mitad y mitad e intercambiar", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  await page.setInputFiles("#fileInput", [`${FIXTURES}/links.pdf`]);
  await expect(page.locator("#docTitle")).toContainText(/links/i);
  // Desde la biblioteca: «Abrir al lado del actual» con paper.pdf.
  await page.click("#homeBtn");
  const card = page.locator("#library .lib-book").filter({ hasText: "paper" });
  await card.hover();
  await card.locator("[data-move-book]").click();
  await page.locator("#libraryMenu button", { hasText: "Abrir al lado" }).click();
  await expect(page.locator("#splitPane")).toBeVisible();
  await expect(page.locator("#splitDoc option:checked")).toContainText("paper");
  await expect.poll(() => page.locator("#splitPages .split-page").count()).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => document.querySelector("#splitPages .split-page canvas").width)).toBeGreaterThan(0);
  // La cabecera cabe en una sola fila y «/ N» no se parte.
  const head = await page.evaluate(() => ({ height: document.querySelector(".split-head").getBoundingClientRect().height, count: document.querySelector("#splitCount").getBoundingClientRect().height }));
  expect(head.height).toBeLessThan(60);
  expect(head.count).toBeLessThan(22);
  // Barras propias: las del sistema no ocupan sitio y la nuestra aparece al desplazarse.
  expect(await page.evaluate(() => { const el = document.querySelector("#splitScroll"); return el.offsetWidth - el.clientWidth; })).toBe(0);
  // Se acerca para que la página no quepa y haya que desplazarse.
  for (let i = 0; i < 4; i++) await page.click("#splitZoomIn");
  await expect(page.locator("#splitZoomLevel")).toHaveText("207 %");
  await expect(page.locator("#splitPane .own-scrollbar-y")).not.toHaveAttribute("hidden", "");
  await page.locator("#splitScroll").hover();
  await page.mouse.wheel(0, 300);
  await expect(page.locator("#splitPane .own-scrollbar-y")).toHaveClass(/is-active/);
  const thumb = page.locator("#splitPane .own-scrollbar-y .own-scrollbar-thumb");
  // Se espera a que termine el desplazamiento (puede ser animado) antes de medir el asa.
  const scrollTop = () => page.evaluate(() => document.querySelector("#splitScroll").scrollTop);
  let scrolled = -1;
  await expect.poll(async () => {
    const previous = scrolled;
    scrolled = await scrollTop();
    await page.waitForTimeout(150);
    return scrolled > 0 && scrolled === previous;
  }).toBe(true);
  const tb = await thumb.boundingBox();
  const y = tb.y + tb.height / 2;
  await page.mouse.move(tb.x + tb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, y + 150, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.querySelector("#splitScroll").scrollTop)).toBeGreaterThan(scrolled + 100);

  // Arrastrar el divisor cambia el ancho de los dos lados.
  const handle = page.locator("#splitResizer");
  const box = await handle.boundingBox();
  const before = await splitWidth(page);
  await page.mouse.move(box.x + box.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, 400, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => splitWidth(page)).toBeGreaterThan(before + 150);
  const viewerRight = await page.evaluate(() => document.querySelector("#viewer").getBoundingClientRect().right);
  const paneLeft = await page.evaluate(() => document.querySelector("#splitPane").getBoundingClientRect().left);
  expect(Math.abs(viewerRight - paneLeft)).toBeLessThan(4);
  // Nunca deja un lado demasiado estrecho.
  const box2 = await handle.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(5, 400, { steps: 6 });
  await page.mouse.up();
  const main = await page.evaluate(() => document.querySelector(".main").getBoundingClientRect().width);
  expect(await splitWidth(page)).toBeLessThanOrEqual(main - 240 + 1);
  // Doble clic: mitad y mitad (y se recuerda).
  await handle.dblclick();
  await expect.poll(async () => Math.abs((await splitWidth(page)) - main / 2)).toBeLessThan(3);

  // Intercambiar: paper pasa a la izquierda y links a la derecha.
  await page.click("#splitSwap");
  await expect(page.locator("#docTitle")).toContainText(/paper/i);
  await expect(page.locator("#splitDoc option:checked")).toContainText("links");

  // Cerrar y volver a abrir: recuerda el documento de al lado.
  await page.click("#splitClose");
  await expect(page.locator("#splitPane")).toBeHidden();
  await page.keyboard.press("d");
  await expect(page.locator("#splitPane")).toBeVisible();
  await expect(page.locator("#splitDoc option:checked")).toContainText("links");
});

test("en una tableta en vertical (iPad mini) también se puede dividir", async ({ page }) => {
  await page.setViewportSize({ width: 744, height: 1000 });
  await openDoc(page, "paper.pdf");
  await page.evaluate(() => document.querySelector("#splitViewBtn").click());
  await expect(page.locator("#splitPane")).toBeVisible();
  const width = await splitWidth(page);
  expect(width).toBeGreaterThanOrEqual(240);
});
