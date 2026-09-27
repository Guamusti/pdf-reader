// Ayudas comunes de las pruebas de navegador.
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const FIXTURES = `${here}.fixtures`;
const NM = `${here}node_modules`;

// Las librerías que la app carga de los CDN se sirven desde node_modules: las
// pruebas no dependen de la red ni de la disponibilidad de los CDN.
export async function offlineCdn(context) {
  await context.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/4\.10\.38\/(pdf(\.worker)?\.min\.mjs)/, (route, request) =>
    route.fulfill({ path: `${NM}/pdfjs-dist/build/${request.url().split("/").pop()}`, contentType: "text/javascript" }),
  );
  await context.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf-lib\/1\.17\.1\/pdf-lib\.min\.js/, (route) =>
    route.fulfill({ path: `${NM}/pdf-lib/dist/pdf-lib.min.js`, contentType: "text/javascript" }),
  );
  await context.route(/cdn\.jsdelivr\.net\/npm\/katex@0\.16\.22\/dist\/(.*)/, (route, request) => route.fulfill({ path: `${NM}/katex/dist/${request.url().split("/dist/")[1]}` }));
  await context.route(/cdn\.jsdelivr\.net\/npm\/tesseract\.js@[^/]+\/dist\/(.*)/, (route, request) =>
    route.fulfill({ path: `${NM}/tesseract.js/dist/${request.url().split("/dist/")[1]}`, contentType: "text/javascript" }),
  );
  await context.route(/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@[^/]+\/(.*)/, (route, request) => {
    const file = request.url().split("/").pop();
    route.fulfill({ path: `${NM}/tesseract.js-core/${file}`, contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
  });
  await context.route(/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/(eng|spa)\/([^/]+)\/(.*)/, (route, request) => {
    const [, lang, version, file] = request.url().match(/@tesseract\.js-data\/(eng|spa)\/([^/]+)\/(.*)/);
    route.fulfill({ path: `${NM}/@tesseract.js-data/${lang}/${version}/${file}` });
  });
  // WebLLM y las fuentes externas no se usan en las pruebas.
  await context.route(/esm\.run|fonts\.googleapis|fonts\.gstatic/, (route) => route.abort());
}

// IA integrada del navegador simulada (con visión): guarda los prompts en
// window.__prompts y responde `answer` en trozos.
export async function mockBuiltinAi(context, answer, { delay = 5 } = {}) {
  await context.addInitScript(
    ({ answer, delay }) => {
      window.__prompts = [];
      const session = {
        async *promptStreaming(input) {
          window.__prompts.push(input);
          for (const part of answer.match(/[\s\S]{1,20}/g)) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            yield part;
          }
        },
        clone() {
          return session;
        },
        destroy() {},
      };
      window.LanguageModel = { availability: async () => "available", create: async () => session };
    },
    { answer, delay },
  );
}

export async function openDoc(page, name) {
  await page.goto("/");
  await page.waitForSelector("#fileInput", { state: "attached" });
  await page.setInputFiles("#fileInput", `${FIXTURES}/${name}`);
  await page.waitForSelector("#canvasWrap:not([hidden]) canvas, #continuousView:not([hidden]) .cont-page canvas");
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
}

// Arrastre con el ratón entre dos puntos.
export async function drag(page, x1, y1, x2, y2, steps = 6) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps });
  await page.mouse.up();
}

// Lápiz y dedo reales a través del protocolo de Chrome.
export async function stylus(context, page) {
  const cdp = await context.newCDPSession(page);
  return {
    pen: (type, x, y, force = 0.5) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force }),
    touch: (type, points = []) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, radius = 8, id = 1]) => ({ x, y, radiusX: radius, radiusY: radius, id })) }),
    cdp,
  };
}

// Recuadro de una palabra dentro de una capa de texto.
export function wordRect(page, scope, word) {
  return page.evaluate(
    ([scope, word]) => {
      const span = [...document.querySelectorAll(`${scope} .textLayer span`)].find((item) => item.textContent.includes(word));
      if (!span) return null;
      span.scrollIntoView({ block: "center" });
      const index = span.textContent.indexOf(word);
      const range = document.createRange();
      range.setStart(span.firstChild, index);
      range.setEnd(span.firstChild, index + word.length);
      return range.getBoundingClientRect().toJSON();
    },
    [scope, word],
  );
}

// Píxeles amarillos de un lienzo (tinta amarilla de la pizarra).
export function yellowPixels(page, selector) {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 120) count++;
    return count;
  }, selector);
}

export async function selectInkTool(page, tool) {
  if (!(await page.evaluate(() => document.body.classList.contains("ink-toolbar-open")))) await page.click("#markerModeBtn");
  await page.evaluate((tool) => document.querySelector(`[data-strip-tool="${tool}"]`).click(), tool);
  // La tarjeta de color tapa parte de la página en ventanas pequeñas.
  await page.evaluate(() => document.getElementById("inkColorCard")?.setAttribute("hidden", ""));
  await page.waitForTimeout(150);
}
