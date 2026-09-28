// Servidor estático mínimo de la raíz del repositorio para las pruebas.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

http
  .createServer(async (request, response) => {
    // También bajo /pdf-reader/, como la publica GitHub Pages.
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/pdf-reader(?=\/)/, "");
    const file = normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root) || file.includes("node_modules")) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      response.end(body);
    } catch {
      response.writeHead(404).end("No encontrado");
    }
  })
  .listen(Number(process.env.PORT || 8791));
