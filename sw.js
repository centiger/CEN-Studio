const CACHE_NAME = 'cen-studio-v0.1.3';
const ASSETS = ['./','./index.html','./style.css','./app.js?v=0.1.2','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)));
});
self.addEventListener('activate', event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event=>{
  event.respondWith(caches.match(event.request).then(cached=>cached || fetch(event.request)));
});
