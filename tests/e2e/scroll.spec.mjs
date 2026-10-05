import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc, stylus } from "./helpers.mjs";

// Bloqueo de eje: con la página ampliada, un gesto casi vertical no la mueve
// de lado (y uno casi horizontal no la mueve en vertical).
test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

async function zoomedIn(page) {
  await openDoc(page, "refs.pdf");
  for (let i = 0; i < 5; i++) await page.click("#zoomIn");
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => {
    const viewer = document.getElementById("viewer");
    viewer.scrollLeft = (viewer.scrollWidth - viewer.clientWidth) / 2;
    viewer.scrollTop = 200;
    return { wide: viewer.scrollWidth - viewer.clientWidth, tall: viewer.scrollHeight - viewer.clientHeight };
  });
  expect(box.wide).toBeGreaterThan(300);
  expect(box.tall).toBeGreaterThan(600);
}
const position = (page) => page.evaluate(() => ({ left: document.getElementById("viewer").scrollLeft, top: document.getElementById("viewer").scrollTop }));
async function swipe(touch, from, dx, dy, steps = 12) {
  await touch("touchStart", [[from.x, from.y]]);
  for (let i = 1; i <= steps; i++) await touch("touchMove", [[from.x + (dx * i) / steps, from.y + (dy * i) / steps]]);
  await touch("touchEnd");
}

test("un gesto casi vertical no desplaza de lado (ni con inercia)", async ({ page, context }) => {
  await zoomedIn(page);
  const { touch } = await stylus(context, page);
  const before = await position(page);
  // 300 px hacia arriba con 40 px de deriva lateral (≈7,6°).
  await swipe(touch, { x: 400, y: 900 }, 40, -300);
  await page.waitForTimeout(900);
  const after = await position(page);
  expect(Math.abs(after.left - before.left)).toBeLessThan(1);
  expect(after.top - before.top).toBeGreaterThan(290);
});

test("un gesto casi horizontal no desplaza en vertical", async ({ page, context }) => {
  await zoomedIn(page);
  const { touch } = await stylus(context, page);
  const before = await position(page);
  await swipe(touch, { x: 600, y: 700 }, -260, 35);
  await page.waitForTimeout(900);
  const after = await position(page);
  expect(Math.abs(after.top - before.top)).toBeLessThan(1);
  expect(after.left - before.left).toBeGreaterThan(150);
});

test("en diagonal se mueve libremente", async ({ page, context }) => {
  await zoomedIn(page);
  const { touch } = await stylus(context, page);
  const before = await position(page);
  await swipe(touch, { x: 600, y: 900 }, -200, -200);
  await page.waitForTimeout(900);
  const after = await position(page);
  expect(after.left - before.left).toBeGreaterThan(150);
  expect(after.top - before.top).toBeGreaterThan(150);
});
