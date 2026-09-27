import { test, expect } from "@playwright/test";
import http from "node:http";
import { offlineCdn, mockBuiltinAi, openDoc, drag } from "./helpers.mjs";

const ANSWER = "### Definición y papel de cada símbolo\n- $V_\\lambda$: módulo irreducible\n- $h(i,j)$: longitud del gancho\n\n$$\\dim V_\\lambda = \\frac{n!}{\\prod h(i,j)}$$\n\nCuesta $5 y $10 [p. 1].";

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

test("recorte de varias áreas, menú de preguntas y fórmulas con KaTeX", async ({ page, context }) => {
  await mockBuiltinAi(context, ANSWER);
  await openDoc(page, "paper.pdf");
  const box = await page.locator("#pdfCanvas").boundingBox();
  await page.keyboard.press("x");
  await expect(page.locator("#captureOverlay")).toHaveClass(/show/);
  await drag(page, box.x + box.width * 0.2, box.y + box.height * 0.13, box.x + box.width * 0.85, box.y + box.height * 0.2);
  const menu = page.locator("#promptMenu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Define los símbolos y describe su papel");
  await expect(menu).toContainText("1 área adjunta");
  await expect(page.locator(".area-mark")).toHaveCount(1);

  await page.click("[data-prompt-add]");
  await drag(page, box.x + box.width * 0.05, box.y + box.height * 0.2, box.x + box.width * 0.95, box.y + box.height * 0.27);
  await expect(page.locator(".pm-foot")).toHaveText("2 áreas adjuntas");

  await page.click('[data-prompt-action="symbols"]');
  const answer = page.locator(".as-msg.as-bot:not(.is-pending) .as-answer").last();
  await expect(answer.locator(".katex").first()).toBeVisible();
  await expect(answer.locator(".katex-display")).toHaveCount(1);
  // Un importe con dólares no se confunde con una fórmula.
  await expect(answer).toContainText("Cuesta $5 y $10");
  const prompt = await page.evaluate(() => window.__prompts[0][0].content.find((part) => part.type === "text").value);
  expect(prompt).toContain("2 recortes numerados");
  expect(prompt).toContain("Define cada símbolo");
  // El recorte se vuelve a dibujar desde el PDF a alta resolución.
  const width = await page.evaluate(() => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.src = document.querySelector(".as-areas img").src; }));
  expect(width).toBeGreaterThanOrEqual(1500);
});

test("minimizado, el asistente es un cuadradito que avisa de la respuesta", async ({ page, context }) => {
  await mockBuiltinAi(context, "Una respuesta lenta.", { delay: 150 });
  await openDoc(page, "paper.pdf");
  await page.click("#captureBtn");
  await page.fill("#assistantInput", "¿Qué es V?");
  await page.keyboard.press("Enter");
  await page.click("#assistantMinimize");
  const panel = page.locator("#assistantPanel");
  const box = await panel.boundingBox();
  expect(Math.round(box.width)).toBe(52);
  expect(Math.round(box.height)).toBe(52);
  await expect(panel).toHaveClass(/has-unread/, { timeout: 10_000 });
  await panel.click();
  expect((await panel.boundingBox()).width).toBeGreaterThan(300);
  await expect(panel).not.toHaveClass(/has-unread/);
});

test("motor de IA: servidor local compatible con OpenAI, sin <think>", async ({ page, context }) => {
  const server = http.createServer((request, response) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    if (request.method === "OPTIONS") return response.writeHead(204, cors).end();
    if (request.url === "/v1/models") return response.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "texto:7b" }, { id: "vision:7b" }] }));
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { model, messages } = JSON.parse(body);
      const text = `<think>secreto</think>Modelo ${model}${JSON.stringify(messages).includes("image_url") ? " con imagen" : ""}: $n!$.`;
      response.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
      for (const part of text.match(/[\s\S]{1,6}/g)) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  try {
    await openDoc(page, "paper.pdf");
    await page.click("#captureBtn");
    await page.click("#assistantModel");
    await expect(page.locator(".as-profiles b")).toHaveText(["Automático", "Ligero", "Equilibrado", "Avanzado", "Máximo", "Tu ordenador (Ollama / LM Studio)"]);
    await page.click('[data-ai-profile="server"]');
    await page.fill('[data-ai-server="url"]', url);
    await page.dispatchEvent('[data-ai-server="url"]', "change");
    await page.click("[data-ai-server-test]");
    await expect(page.locator("[data-ai-server-status]")).toContainText("2 modelos");
    for (const [field, value] of [["model", "texto:7b"], ["visionModel", "vision:7b"]]) {
      await page.fill(`[data-ai-server="${field}"]`, value);
      await page.dispatchEvent(`[data-ai-server="${field}"]`, "change");
    }
    await page.click("[data-ai-settings-close]");
    await page.fill("#assistantInput", "¿Dimensión?");
    await page.keyboard.press("Enter");
    const answer = page.locator(".as-msg.as-bot:not(.is-pending) .as-answer").last();
    await expect(answer).toContainText("Modelo texto:7b");
    await expect(page.locator("#assistantThread")).not.toContainText("secreto");
  } finally {
    server.close();
  }
});
