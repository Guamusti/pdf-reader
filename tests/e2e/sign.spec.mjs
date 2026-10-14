import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { offlineCdn, openDoc, FIXTURES } from "./helpers.mjs";

// Texto y firma sobre el documento, incrustados al exportar.
test.use({ viewport: { width: 1200, height: 950 } });
test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});
async function chooseTool(page, tool) {
  if (!(await page.evaluate(() => document.body.classList.contains("ink-toolbar-open")))) await page.click("#markerModeBtn");
  await page.evaluate((tool) => document.querySelector(`[data-strip-tool="${tool}"]`).click(), tool);
}
async function drawSignature(page) {
  const pad = page.locator("#signaturePad canvas");
  await expect(pad).toBeVisible();
  const p = await pad.boundingBox();
  await page.mouse.move(p.x + 40, p.y + 130);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(p.x + 40 + i * 12, p.y + 130 - Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.click("[data-sp-save]");
}
const pageText = async (bytes, number = 1) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const page = await doc.getPage(number);
  const ops = await page.getOperatorList();
  return { doc, text: (await page.getTextContent()).items.map((item) => item.str).join(" "), paths: ops.fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length };
};

test("formulario XFA: texto, fecha y firma en el «PDF para enviar»", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#fileInput", { state: "attached" });
  await page.setInputFiles("#fileInput", `${FIXTURES}/xfa.pdf`);
  await page.waitForSelector("#canvasWrap .xfa-host .xfaLayer input");
  await page.locator("#canvasWrap .xfa-host input").first().fill("Ana García");
  await page.keyboard.press("Tab");
  const box = await page.locator("#canvasWrap").boundingBox();

  await chooseTool(page, "text");
  await expect(page.locator("#inkColorCard")).toBeHidden();
  await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.6);
  await expect(page.locator("#annotationEditor [data-editor-text]")).toBeFocused();
  await page.keyboard.type("Madrid,");
  await page.click("[data-editor-today]");
  await expect(page.locator("#canvasWrap .object-layer .annotation-text")).toContainText(/Madrid, \d\d\/\d\d\/\d{4}/);

  // La primera vez se dibuja la firma; luego se coloca con un toque.
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await chooseTool(page, "signature");
  await drawSignature(page);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.62);
  await expect(page.locator("#canvasWrap .object-layer .annotation-signature path")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await page.click("#markerModeBtn");
  await page.click("#mobileMoreBtn");
  await page.click('[data-mm="pdf"]');
  await expect(page.locator(".choose-dialog")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-choose="flat"]')]);
  expect(download.suggestedFilename()).toBe("xfa-para-enviar.pdf");
  const { doc, text, paths } = await pageText(await readFile(await download.path()));
  // Un PDF normal (sin XFA), con el formulario, los datos, el texto y la firma.
  expect(doc.isPureXfa).toBe(false);
  expect(doc.numPages).toBe(2);
  expect(text).toContain("Solicitud de prueba XFA");
  expect(text).toContain("Ana García");
  expect(text).toMatch(/Madrid, \d\d\/\d\d\/\d{4}/);
  expect(paths).toBeGreaterThan(3);
});

test("PDF normal: texto y firma incrustados, moverlos y reutilizar la firma", async ({ page }) => {
  await openDoc(page, "paper.pdf");
  const box = await page.locator("#canvasWrap").boundingBox();
  await chooseTool(page, "text");
  await page.mouse.click(box.x + box.width * 0.1, box.y + 380);
  await page.keyboard.type("Revisado por Ana");
  await page.waitForTimeout(600);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 560);

  await chooseTool(page, "signature");
  await drawSignature(page);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 470);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 560);
  // La segunda firma ya no pide dibujarla.
  await page.mouse.click(box.x + box.width * 0.8, box.y + 300);
  await expect(page.locator("#signaturePad")).toHaveCount(0);
  await expect(page.locator(".annotation-signature")).toHaveCount(2);

  // Arrastrar mueve el objeto; el tirador lo hace más grande.
  await page.keyboard.press("Escape");
  await page.click("#markerModeBtn");
  const text = page.locator(".annotation-text");
  const before = await text.boundingBox();
  await page.mouse.move(before.x + 10, before.y + 5);
  await page.mouse.down();
  await page.mouse.move(before.x + 110, before.y + 65, { steps: 8 });
  await page.mouse.up();
  const after = await text.boundingBox();
  expect(Math.round(after.x - before.x)).toBe(100);
  expect(Math.round(after.y - before.y)).toBe(60);
  const sig = page.locator(".annotation-signature").first();
  await sig.click();
  const sigBox = await sig.boundingBox();
  const handle = await sig.locator(".ao-resize").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 80, handle.y + 10, { steps: 6 });
  await page.mouse.up();
  expect((await sig.boundingBox()).width).toBeGreaterThan(sigBox.width + 60);

  await page.click("#mobileMoreBtn");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-mm="pdf"]')]);
  const { text: content, paths } = await pageText(await readFile(await download.path()));
  expect(content).toContain("Revisado por Ana");
  expect(content).toContain("Dimensions of irreducible representations");
  expect(paths).toBeGreaterThan(1);
});
