/* Mes voyages — mise en cache pour ouvrir l'appli sans connexion (version web) */
const CACHE = "mes-voyages-v2";
const SHELL = ["./", "index.html", "collab-firebase.js", "app-extras.js", "city-places.js", "fonts.css", "firebase-config.js", "manifest.webmanifest",
  "fonts/font-0.ttf", "fonts/font-1.ttf", "fonts/font-2.ttf", "fonts/font-3.ttf", "fonts/font-4.ttf", "fonts/font-7.ttf",
  "vendor/firebase-app-compat.js", "vendor/firebase-auth-compat.js", "vendor/firebase-firestore-compat.js",
  "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === location.origin;
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return; // Firebase, taux de change… : toujours en direct
  // Réseau d'abord (pour recevoir les mises à jour), cache si hors connexion
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
