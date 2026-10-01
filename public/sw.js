/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Service worker : l'appli et la dernière version de la carte restent disponibles sans réseau.
const APP_CACHE = 'uac-map-app-v3';
// v2 : la v1 a pu garder les images « Access blocked » d'OpenStreetMap, servies en 200 sans Referer.
const TILE_CACHE = 'uac-map-tiles-v2';
const MAX_CACHED_TILES = 1500;
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/mapEditor.js',
  '/collectMode.js',
  '/contributionMode.js',
  '/proposalLabels.js',
  '/reviewPanel.js',
  '/panelWidgets.js',
  '/proposalsTab.js',
  '/contributorsTab.js',
  '/historyTab.js',
  '/administrationTab.js',
  '/apiClient.js',
  '/safeHtml.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/shared/geo.js',
  '/shared/graph.js',
  '/shared/search.js',
  '/shared/instructions.js',
  '/shared/presence.js',
  '/shared/proposalDiff.js',
  '/vendor/maplibre/maplibre-gl.mjs',
  '/vendor/maplibre/maplibre-gl-shared.mjs',
  '/vendor/maplibre/maplibre-gl-worker.mjs',
  '/vendor/maplibre/maplibre-gl.css',
];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== APP_CACHE && cacheName !== TILE_CACHE)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Réseau d'abord, cache en secours : l'appli et la dernière carte restent consultables hors ligne.
async function fetchWithCacheFallback(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cachedResponse = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    return cachedResponse || (request.mode === 'navigate' ? cache.match('/') : Response.error());
  }
}

// Tuiles : cache d'abord, avec un plafond pour ne pas saturer le stockage du téléphone.
async function fetchTile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const cachedRequests = await cache.keys();
    const overflow = cachedRequests.length - MAX_CACHED_TILES;
    if (overflow > 0)
      await Promise.all(cachedRequests.slice(0, overflow).map((cachedRequest) => cache.delete(cachedRequest)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(fetchTile(request));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/campus-map') return;
  event.respondWith(fetchWithCacheFallback(request));
});
