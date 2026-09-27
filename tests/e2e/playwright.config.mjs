// Pruebas de navegador: cd tests/e2e && npm ci && npx playwright test
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  globalSetup: "./global-setup.mjs",
  webServer: { command: "node server.mjs", port: 8791, reuseExistingServer: !process.env.CI },
  use: {
    baseURL: "http://localhost:8791",
    browserName: "chromium",
    // El service worker de la app haría él mismo las peticiones a los CDN y no
    // pasarían por las copias locales de las pruebas; solo la prueba de
    // arranque lo activa.
    serviceWorkers: "block",
    // En entornos con Chromium ya instalado en otra ruta.
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
});
