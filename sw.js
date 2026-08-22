const CACHE = 'paper-reader-v80';
const CORE = ['/', '/index.html', '/reader-ui.css?v=32', '/app.js?v=67', '/ai-worker.js?v=1', '/manifest.json', '/icon-192.png', '/icon-512.png'];
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
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // Navegación: la red manda (para recibir siempre el HTML más reciente) y la
  // copia en caché sirve solo como reserva sin conexión.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(request)) || (await caches.match('/index.html')) || Response.error();
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
