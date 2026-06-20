/* sw.js - Tachometer PWA Service Worker */

const CACHE_NAME = 'tachometer-cache-v1.9'; // Version erhöht für Update-Zwang
const TILE_CACHE_NAME = 'tachometer-tiles-v1.9';

const STATIC_ASSETS = [
  '/',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// 1. Install Event - Assets in den Cache laden
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching der App-Shell');
        // addAll schlägt fehl, wenn eine einzige URL eine 404 wirft.
        // Falls './' Probleme macht, wird hier zur Sicherheit jeder Pfad gecacht.
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting()) // Zwingt den neuen SW zur Aktivierung
  );
});

// 2. Activate Event - Alte Cache-Versionen löschen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== TILE_CACHE_NAME) {
            console.log('[Service Worker] Lösche alten Cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // Übernimmt sofort die Kontrolle
  );
});

// 3. Fetch Event - Die eigentliche Offline-Logik
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // STRATEGIE A: Karten-Kacheln (Kombination aus Cache und Netzwerk)
  if (requestUrl.hostname.includes('basemaps.cartocdn.com') || requestUrl.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse; // Kachel aus Cache zeigen

          return fetch(event.request).then((networkResponse) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          }).catch(() => {
            // Offline-Fallback für eine fehlende Karte (leeres Bild oder Text)
            return new Response('Karte offline nicht verfügbar', { status: 404 });
          });
        });
      })
    );
    return;
  }

  // STRATEGIE B: Der kritische Punkt – Das Laden der eigentlichen App/HTML im Offline-Modus
  if (event.request.mode === 'navigate') {
    event.respondWith(
      // Versuche immer zuerst den Cache für die Hauptseite, damit sie SOFORT lädt (Offline-First)
      caches.match('./index.html').then((cachedHtml) => {
        if (cachedHtml) {
          // Im Hintergrund das Netzwerk nach Updates fragen
          fetch(event.request).then((networkResponse) => {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }).catch(() => {/* Ignorieren wenn offline */});
          
          return cachedHtml;
        }
        // Falls nicht im Cache (beim allerersten Aufruf), lade aus dem Netzwerk
        return fetch(event.request);
      }).catch(() => {
        // Absoluter Notfall-Fallback
        return caches.match('/');
      })
    );
    return;
  }

  // STRATEGIE C: Alle anderen statischen Assets (CSS, JS, Leaflet-Bibliotheken)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Nur eigene Dateien automatisch für das nächste Mal cachen
        if (event.request.url.startsWith(self.location.origin)) {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        }
        return networkResponse;
      }).catch(() => {
        return new Response('Asset offline nicht verfügbar', { status: 404 });
      });
    })
  );
});