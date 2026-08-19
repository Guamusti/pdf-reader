const CACHE='paper-reader-v6';
const CORE=['/','/index.html','/app.js?v=6','/manifest.json','/icon-192.png','/icon-512.png'];
const PDFJS=['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs'];
self.addEventListener('install',event=>{event.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(CORE);for(const url of PDFJS){try{await c.add(url)}catch{}}})());self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim()})())});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith((async()=>{try{if(event.request.mode==='navigate'){const fresh=await fetch(event.request);const c=await caches.open(CACHE);c.put(event.request,fresh.clone());return fresh}const cached=await caches.match(event.request);if(cached)return cached;const res=await fetch(event.request);const c=await caches.open(CACHE);c.put(event.request,res.clone());return res}catch{return caches.match('/index.html')}})())});
