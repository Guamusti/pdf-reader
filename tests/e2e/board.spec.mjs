import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc, drag, stylus, yellowPixels } from "./helpers.mjs";

test.use({ viewport: { width: 1300, height: 850 }, hasTouch: true });

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

async function openBoard(page, file = "paper.pdf") {
  await openDoc(page, file);
  await page.keyboard.press("w");
  await expect(page.locator("#boardPane")).toBeVisible();
}

test("Apple Pencil: trazos, palma, «Solo lápiz», deshacer y guardado", async ({ page, context }) => {
  await openBoard(page);
  const { pen, touch } = await stylus(context, page);
  const b = await page.locator("#boardLive").boundingBox();
  const penStroke = async (x0, y0) => {
    await pen("mousePressed", b.x + x0, b.y + y0);
    for (let i = 1; i <= 20; i++) await pen("mouseMoved", b.x + x0 + i * 10, b.y + y0 + Math.sin(i / 2) * 15, 0.3 + i / 40);
    await pen("mouseReleased", b.x + x0 + 200, b.y + y0);
  };
  await penStroke(60, 120);
  const one = await yellowPixels(page, "#boardCanvas");
  expect(one).toBeGreaterThan(200);
  // El primer uso de un lápiz activa «Solo lápiz».
  await expect(page.locator("[data-board-penonly]")).toHaveAttribute("aria-pressed", "true");

  // Palma ancha apoyada mientras el lápiz escribe: no dibuja ni desplaza.
  await page.evaluate(() => (document.getElementById("boardSpacer").style.height = "2000px"));
  await pen("mousePressed", b.x + 60, b.y + 260);
  await touch("touchStart", [[b.x + 300, b.y + 500, 40]]);
  for (let i = 1; i <= 20; i++) {
    await pen("mouseMoved", b.x + 60 + i * 10, b.y + 260 + Math.sin(i) * 10);
    if (i % 4 === 0) await touch("touchMove", [[b.x + 300 - i * 3, b.y + 500 - i * 8, 40]]);
  }
  await touch("touchEnd");
  await pen("mouseReleased", b.x + 260, b.y + 260);
  const two = await yellowPixels(page, "#boardCanvas");
  expect(two).toBeGreaterThan(one + 150);
  expect(await page.evaluate(() => document.getElementById("boardScroll").scrollTop)).toBe(0);

  // Con «Solo lápiz», el dedo desplaza y no dibuja.
  await page.waitForTimeout(700);
  await touch("touchStart", [[b.x + 200, b.y + 600]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[b.x + 200, b.y + 600 - i * 30]]);
  await touch("touchEnd");
  // La pizarra es corta: basta con comprobar que el dedo la desplaza.
  await expect.poll(() => page.evaluate(() => document.getElementById("boardScroll").scrollTop)).toBeGreaterThan(20);
  expect(Math.abs((await yellowPixels(page, "#boardCanvas")) - two)).toBeLessThan(50);

  // Deshacer y rehacer.
  await page.evaluate(() => (document.getElementById("boardScroll").scrollTop = 0));
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+z");
  expect(await yellowPixels(page, "#boardCanvas")).toBeLessThan(two - 100);
  await page.keyboard.press("Control+Shift+z");
  expect(await yellowPixels(page, "#boardCanvas")).toBeGreaterThan(two - 50);

  // Se guarda (de forma diferida) y se recupera al recargar.
  await expect(page.locator("#boardStatus")).toHaveText("Guardado");
  await page.reload();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.keyboard.press("w");
  await expect(page.locator("#boardEmpty")).toBeHidden();
});

test("recortes enlazados: pastilla hacia el PDF y marca del PDF hacia la pizarra", async ({ page }) => {
  await openBoard(page);
  const pdf = await page.locator("#pdfCanvas").boundingBox();
  await page.click("[data-board-crop]");
  await drag(page, pdf.x + pdf.width * 0.1, pdf.y + pdf.height * 0.05, pdf.x + pdf.width * 0.9, pdf.y + pdf.height * 0.2);
  await expect(page.locator('[data-board-mode="move"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#canvasWrap .board-link-mark")).toHaveCount(1);
  // La pastilla «p. N ↗» se dibuja en azul en el lienzo: se localiza y se pulsa.
  const badge = await page.evaluate(() => {
    const canvas = document.getElementById("boardCanvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const dpr = canvas.width / canvas.clientWidth;
    for (let y = 0; y < canvas.height; y += 2)
      for (let x = canvas.width - 1; x > 0; x -= 2) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] === 59 && data[i + 1] === 124 && data[i + 2] === 255) {
          const box = canvas.getBoundingClientRect();
          return { x: box.x + x / dpr - 6, y: box.y + y / dpr + 8 };
        }
      }
    return null;
  });
  expect(badge).not.toBeNull();
  await page.mouse.click(badge.x, badge.y);
  await expect(page.locator(".source-flash")).toHaveCount(1);
  await page.click("[data-board-close]");
  await page.click("#canvasWrap .board-link-mark button");
  await expect(page.locator("#boardPane")).toBeVisible();
});

test("la pizarra sigue la lectura", async ({ page }) => {
  await openBoard(page, "refs.pdf");
  await page.click('[data-board-mode="pen"]');
  await page.click("[data-board-follow]");
  const b = await page.locator("#boardLive").boundingBox();
  const scribble = async (y) => drag(page, b.x + 80, b.y + y, b.x + 250, b.y + y + 10, 12);
  const goTo = async (n) => {
    await page.evaluate((n) => { const input = document.getElementById("pageJump"); input.value = n; input.dispatchEvent(new Event("change")); }, n);
    await page.waitForTimeout(900);
  };
  await scribble(120);
  await goTo(3);
  await expect(page.locator("#boardStatus")).toHaveText("Sin apuntes de la p. 3");
  await scribble(400);
  await goTo(1);
  await expect(page.locator("#boardStatus")).toHaveText("Apuntes de la p. 1");
  await goTo(3);
  await expect(page.locator("#boardStatus")).toHaveText("Apuntes de la p. 3");
});
