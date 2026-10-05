const CACHE = 'paper-reader-v117';
const SHARE_CACHE = 'paper-share';
// Rutas relativas al propio service worker: la app funciona igual en la raíz
// de un dominio (Vercel) que en una subcarpeta (GitHub Pages: /pdf-reader/).
const CORE = ['./', 'index.html', 'reader-ui.css?v=32', 'reader-v3.css?v=8', 'reader-v6.css?v=21', 'app.js?v=103', 'pdf-engine.js?v=1', 'storage.js?v=2', 'sync.js?v=2', 'references.js?v=5', 'epub.js?v=1', 'ai-worker.js?v=1', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const INDEX = new URL('index.html', self.location).href;
const appUrl = (path) => new URL(path, self.registration.scope).href;
const PDFJS = ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs'];

// El precacheo es tolerante a fallos: si un recurso concreto no se puede
// guardar, la instalación no se aborta (antes un único 404 la tumbaba).
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([...CORE, ...PDFJS].map(url => cache.add(url).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== SHARE_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Compartir con Paper Reader (share_target del manifest): los archivos se
  // guardan un momento en una caché propia y la app los recoge al abrirse.
  if (request.method === 'POST' && url.origin === self.location.origin && url.href.split('?')[0] === appUrl('share-target')) {
    event.respondWith((async () => {
      try {
        const form = await request.formData();
        const files = form.getAll('files').filter(file => file && typeof file !== 'string');
        const cache = await caches.open(SHARE_CACHE);
        await Promise.all(files.map((file, index) => cache.put(
          appUrl(`__shared/${Date.now()}-${index}`),
          new Response(file, { headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name || 'documento.pdf') } }),
        )));
        return Response.redirect(appUrl(`./?shared=${files.length}`), 303);
      } catch {
        return Response.redirect(appUrl('./?shared=0'), 303);
      }
    })());
    return;
  }
  if (request.method !== 'GET') return;

  // Navegación: la app se abre al instante desde la copia guardada y la versión
  // nueva se descarga en segundo plano (se aplica en la siguiente apertura).
  // Antes se esperaba a la red en cada arranque: con mala cobertura, segundos.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = (await cache.match(INDEX)) || (await caches.match(request, { ignoreSearch: true }));
      const network = fetch(request).then(async (fresh) => {
        if (fresh && fresh.ok) await cache.put(INDEX, fresh.clone());
        return fresh;
      });
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      try {
        return await network;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // Resto de recursos (scripts, estilos, fuentes de pdf.js, imágenes): caché
  // primero y, si no está, red. Nunca se devuelve el HTML como sustituto: un
  // módulo servido como text/html rompe la app con un error de tipo MIME.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque')) {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
