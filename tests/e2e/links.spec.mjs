import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

// Enlaces internos del PDF (hyperref): «[2.1]», «(3.4)», «[12]».
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
const label = (page) => page.locator(".hover-preview:not([hidden]) .hp-label");
const link = (page, index) => page.locator("#linkLayer a").nth(index);

test.describe("con ratón", () => {
  test.use({ viewport: { width: 1300, height: 900 } });

  test("la vista previa nombra el destino, lo marca y deja leer el contexto", async ({ page }) => {
    await openDoc(page, "links.pdf");
    await expect(page.locator("#linkLayer a")).toHaveCount(4);
    for (const [index, expected] of [[0, "Teorema 2.1 · página 2"], [1, "Ecuación (3.4) · página 2"], [2, "Referencia [12] · página 3"], [3, "«the start of this page» · página 1"]]) {
      await page.mouse.move(10, 10);
      await page.keyboard.press("Escape");
      await link(page, index).hover();
      await expect(label(page)).toHaveText(expected);
    }
    // El teorema está a media página: la vista previa empieza ahí, marcado, y
    // se puede desplazar hacia arriba para ver lo anterior.
    await page.mouse.move(10, 10);
    await page.keyboard.press("Escape");
    await link(page, 0).hover();
    await expect(label(page)).toHaveText("Teorema 2.1 · página 2");
    const preview = await page.evaluate(() => {
      const frame = document.querySelector(".hover-preview .hp-scroll");
      const marker = frame.querySelector(".hp-target").getBoundingClientRect();
      const box = frame.getBoundingClientRect();
      return { scrollTop: frame.scrollTop, scrollable: frame.scrollHeight > frame.clientHeight, markerInside: marker.top >= box.top && marker.bottom <= box.bottom };
    });
    expect(preview.scrollTop).toBeGreaterThan(150);
    expect(preview.scrollable).toBe(true);
    expect(preview.markerInside).toBe(true);
  });

  test("el clic salta al punto exacto, lo resalta y ofrece volver", async ({ page }) => {
    await openDoc(page, "links.pdf");
    await link(page, 0).click();
    await expect(page.locator("#pageJump")).toHaveValue("2");
    const flash = page.locator(".source-flash");
    await expect(flash).toHaveCount(1);
    // El resaltado cae a media página, donde está el teorema.
    const [flashBox, pageBox] = await Promise.all([flash.boundingBox(), page.locator("#canvasWrap").boundingBox()]);
    const relative = (flashBox.y - pageBox.y) / pageBox.height;
    expect(relative).toBeGreaterThan(0.3);
    expect(relative).toBeLessThan(0.55);
    await expect(page.locator("#returnChip")).toContainText("Volver a la p. 1");
    await page.click("#returnChip");
    await expect(page.locator("#pageJump")).toHaveValue("1");
  });
});

test.describe("con el dedo (iPad)", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("el primer toque muestra la vista previa; el segundo, o «Ir», salta", async ({ page }) => {
    await openDoc(page, "links.pdf");
    const box = await link(page, 2).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(label(page)).toHaveText("Referencia [12] · página 3");
    await expect(page.locator("#pageJump")).toHaveValue("1");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#pageJump")).toHaveValue("3");
    await page.click("#returnChip");
    await expect(page.locator("#pageJump")).toHaveValue("1");

    const theorem = await link(page, 0).boundingBox();
    await page.touchscreen.tap(theorem.x + theorem.width / 2, theorem.y + theorem.height / 2);
    await expect(label(page)).toHaveText("Teorema 2.1 · página 2");
    await page.evaluate(() => { window.__flash = []; new MutationObserver((m) => m.forEach((r) => r.addedNodes.forEach((n) => n.classList?.contains("source-flash") && window.__flash.push(performance.now())))).observe(document.body, { subtree: true, childList: true }); });
    await page.locator(".hover-preview .hp-go").tap();
    await expect(page.locator("#pageJump")).toHaveValue("2");
    // El destino se resalta un momento (se registra al aparecer).
    await expect.poll(() => page.evaluate(() => window.__flash.length)).toBe(1);
  });
});
