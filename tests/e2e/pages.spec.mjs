import { test, expect } from "@playwright/test";
import { offlineCdn, openDoc } from "./helpers.mjs";

// GitHub Pages publica la app en una subcarpeta (/pdf-reader/): nada puede
// pedirse a la raíz del dominio.
const BASE = "/pdf-reader/";

test.use({ viewport: { width: 1300, height: 900 } });

test.beforeEach(async ({ context }) => {
  await offlineCdn(context);
});

test("en una subcarpeta, todo se carga desde ella y el PDF se abre", async ({ page }) => {
  const local = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host === "localhost:8791") local.push(url.pathname);
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openDoc(page, "paper.pdf", BASE);
  expect(local.length).toBeGreaterThan(5);
  expect(local.filter((path) => !path.startsWith(BASE))).toEqual([]);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').href;
    const data = await (await fetch(href)).json();
    return { href, start: new URL(data.start_url, href).pathname, icon: new URL(data.icons[1].src, href).pathname, share: new URL(data.share_target.action, href).pathname };
  });
  expect(manifest).toEqual({ href: `http://localhost:8791${BASE}manifest.json`, start: BASE, icon: `${BASE}icon-192.png`, share: `${BASE}share-target` });
  expect(errors).toEqual([]);
});

test.describe("service worker en la subcarpeta", () => {
  test.use({ serviceWorkers: "allow" });

  test("se instala con su alcance, guarda la app y la sirve al volver a abrirla", async ({ page }) => {
    await page.goto(BASE);
    await page.waitForFunction(() => navigator.serviceWorker?.controller || new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve)), null, { timeout: 20_000 });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope)).toBe(`http://localhost:8791${BASE}`);
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((name) => name.startsWith("paper-reader-")));
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });
    for (const path of ["", "index.html", "app.js", "pdf-engine.js", "references.js", "manifest.json"]) expect(cached).toContain(`${BASE}${path}`);
    const response = await page.reload();
    expect(response.fromServiceWorker()).toBe(true);
    await expect(page.locator("#fileInput")).toBeAttached();
  });
});
