/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Map as MapLibreMap, Marker, ScaleControl } from '/vendor/maplibre/maplibre-gl.mjs';
import { buildGraph, findRoute } from '/shared/graph.js';
import { buildSearchIndex, searchPlaces, PLACE_CATEGORIES } from '/shared/search.js';
import { buildRouteSteps, formatDistance, formatDuration } from '/shared/instructions.js';
import { getDistance, locateOnLine, createCirclePolygon, getLineLength } from '/shared/geo.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';
import { initCollectMode } from '/collectMode.js';

const DEFAULT_CENTER = [2.341985, 6.416091];
const MIN_ORIGIN_ACCURACY_METERS = 80;
const MAX_DISTANCE_FROM_CAMPUS_METERS = 3000;
const GPS_WAIT_TIMEOUT_MS = 15000;
const OFF_ROUTE_MIN_METERS = 20;
const FAR_FROM_NETWORK_METERS = 150;
const LABELS_MIN_ZOOM = 17.2;
const MARKER_CLICK_GUARD_MS = 400;
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };
const CLOSE_ICON = html`<svg
  viewBox="0 0 24 24"
  width="22"
  height="22"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
>
  <path d="M6 6l12 12M18 6L6 18" />
</svg>`;

const selectElement = (selector) => document.querySelector(selector);

const state = {
  campusMap: null,
  graph: null,
  searchIndex: null,
  markers: new Map(),
  selectedPlace: null,
  destination: null,
  origin: null, // { kind: 'gps' | 'place' | 'point', position, accuracy?, label? }
  route: null,
  routeOptions: { avoidStairs: false, avoidFlood: false },
  gps: { watchId: null, lastFix: null, subscribers: new Set() },
  isAwaitingOrigin: false,
  navigation: { isActive: false, offRouteCount: 0, isFollowing: true, hasArrived: false },
  mode: null,
  isSatellite: false,
  hooks: { onMapClick: null, onPlaceClick: null },
  lastMarkerClickTime: 0,
  hasCentered: false,
};

// ---------- Carte ----------

const map = new MapLibreMap({
  container: 'map',
  style: {
    version: 8,
    sources: {
      streets: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© contributeurs OpenStreetMap',
      },
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 18,
        attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ebe7df' } },
      { id: 'streets', type: 'raster', source: 'streets' },
      { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
    ],
  },
  center: DEFAULT_CENTER,
  zoom: 16,
  maxZoom: 20.5,
  dragRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

const widthByZoom = (minimum, maximum) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  15,
  minimum,
  18,
  maximum * 0.6,
  20,
  maximum,
];

function addMapLayers() {
  for (const sourceId of ['paths', 'route', 'user', 'origin', 'entrances', 'draft']) {
    map.addSource(sourceId, { type: 'geojson', data: EMPTY_COLLECTION });
  }
  const roundLine = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({
    id: 'paths-casing',
    type: 'line',
    source: 'paths',
    layout: roundLine,
    paint: { 'line-color': '#ffffff', 'line-width': widthByZoom(2.5, 11), 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'paths-line',
    type: 'line',
    source: 'paths',
    layout: roundLine,
    paint: {
      'line-color': [
        'match',
        ['get', 'type'],
        'road',
        '#78716c',
        'track',
        '#a16207',
        'corridor',
        '#0e7490',
        'stairs',
        '#b91c1c',
        '#15803d',
      ],
      'line-width': widthByZoom(1.2, 7),
    },
  });
  map.addLayer({
    id: 'paths-flood',
    type: 'line',
    source: 'paths',
    filter: ['==', ['get', 'isFloodProne'], true],
    paint: {
      'line-color': '#2563eb',
      'line-width': widthByZoom(1, 3),
      'line-dasharray': [1, 1.5],
      'line-offset': widthByZoom(2, 7),
    },
  });
  map.addLayer({
    id: 'paths-hit-area',
    type: 'line',
    source: 'paths',
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 },
  });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: roundLine,
    paint: { 'line-color': '#ffffff', 'line-width': widthByZoom(7, 16) },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: roundLine,
    paint: { 'line-color': '#1d4ed8', 'line-width': widthByZoom(4.5, 10) },
  });
  map.addLayer({
    id: 'draft-line',
    type: 'line',
    source: 'draft',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 1] },
  });
  map.addLayer({
    id: 'draft-points',
    type: 'circle',
    source: 'draft',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#f59e0b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'entrance-points',
    type: 'circle',
    source: 'entrances',
    paint: { 'circle-radius': 6, 'circle-color': '#f97316', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'origin-point',
    type: 'circle',
    source: 'origin',
    paint: { 'circle-radius': 8, 'circle-color': '#14532d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'user-accuracy',
    type: 'fill',
    source: 'user',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15, 'fill-outline-color': '#3b82f6' },
  });
  map.addLayer({
    id: 'user-position',
    type: 'circle',
    source: 'user',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 8, 'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
  });
}

const setSourceData = (sourceId, geoJson) => map.getSource(sourceId)?.setData(geoJson);
const toLineFeature = (coordinates, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates },
});
const toPointFeature = (coordinates, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates },
});
const toFeatureCollection = (features) => ({ type: 'FeatureCollection', features });
const getPlacePosition = (place) => [place.longitude, place.latitude];

function toggleSatellite(isSatellite = !state.isSatellite) {
  state.isSatellite = isSatellite;
  map.setLayoutProperty('satellite', 'visibility', isSatellite ? 'visible' : 'none');
  map.setLayoutProperty('streets', 'visibility', isSatellite ? 'none' : 'visible');
  selectElement('#layer-button').classList.toggle('is-active', isSatellite);
}

// ---------- Interface ----------

let toastTimer;
function showToast(message, durationMs = 3500) {
  const toast = selectElement('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, durationMs);
}

function openSheet(content) {
  const sheet = selectElement('#sheet');
  sheet.innerHTML = html`${content}`;
  sheet.hidden = false;
  document.body.classList.add('has-open-sheet');
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-height', `${sheet.offsetHeight}px`));
}

function closeSheet() {
  selectElement('#sheet').hidden = true;
  document.body.classList.remove('has-open-sheet');
}

const sheetHeader = (title, subtitle, closeLabel = 'Fermer') => html`
  <div class="sheet-handle"></div>
  <div class="sheet-header">
    <div>
      <h2>${title}</h2>
      ${subtitle ? html`<p class="category-label">${subtitle}</p>` : ''}
    </div>
    <button class="icon-button" data-action="close" aria-label="${closeLabel}">${CLOSE_ICON}</button>
  </div>
`;

// ---------- Données ----------

async function loadCampusMap() {
  try {
    const { data } = await callApi('GET', '/campus-map');
    applyCampusMap(data);
  } catch {
    showToast('Impossible de charger la carte. Vérifiez la connexion.');
  }
}

function applyCampusMap(campusMap) {
  state.campusMap = campusMap;
  state.graph = buildGraph(campusMap.paths);
  state.searchIndex = buildSearchIndex(campusMap.places);
  setSourceData(
    'paths',
    toFeatureCollection(
      campusMap.paths.map((path) =>
        toLineFeature(path.coordinates, { id: path.id, type: path.type, isFloodProne: Boolean(path.isFloodProne) }),
      ),
    ),
  );
  renderPlaceMarkers();
  selectElement('#demo-banner').hidden = !campusMap.settings?.isDemo;
  if (!state.hasCentered && campusMap.settings?.center) {
    map.jumpTo({ center: campusMap.settings.center, zoom: campusMap.settings.zoom || 16 });
    state.hasCentered = true;
  }
  if (state.selectedPlace) state.selectedPlace = findPlaceById(state.selectedPlace.id);
  if (state.destination) state.destination = findPlaceById(state.destination.id);
  renderEntrances();
  document.dispatchEvent(new CustomEvent('campus-map-loaded'));
}

function findPlaceById(placeId) {
  return state.campusMap?.places.find((place) => place.id === placeId) || null;
}

function renderPlaceMarkers() {
  for (const marker of state.markers.values()) marker.remove();
  state.markers.clear();
  for (const place of state.campusMap.places) {
    const markerElement = document.createElement('button');
    markerElement.type = 'button';
    markerElement.className = `place-marker category-${place.category}`;
    markerElement.setAttribute('aria-label', place.name);
    markerElement.innerHTML = html`<span class="marker-dot"></span><span class="marker-label">${place.name}</span>`;
    markerElement.addEventListener('click', (event) => {
      event.stopPropagation();
      state.lastMarkerClickTime = Date.now();
      if (state.hooks.onPlaceClick) state.hooks.onPlaceClick(place);
      else selectPlace(place);
    });
    const marker = new Marker({ element: markerElement, anchor: 'bottom' })
      .setLngLat(getPlacePosition(place))
      .addTo(map);
    state.markers.set(place.id, marker);
  }
  highlightSelectedMarker();
}

function highlightSelectedMarker() {
  const highlighted = state.destination || state.selectedPlace;
  for (const [placeId, marker] of state.markers) {
    marker.getElement().classList.toggle('is-selected', Boolean(highlighted) && highlighted.id === placeId);
  }
}

function renderEntrances() {
  const toEntranceFeatures = (place) =>
    place.entrances.map((entrance) => toPointFeature([entrance.longitude, entrance.latitude]));
  if (state.mode === 'collect') {
    setSourceData('entrances', toFeatureCollection(state.campusMap.places.flatMap(toEntranceFeatures)));
    return;
  }
  const place = state.destination || state.selectedPlace;
  setSourceData('entrances', toFeatureCollection(place ? toEntranceFeatures(place) : []));
}

// ---------- Recherche ----------

const searchInput = selectElement('#search-input');
const searchResults = selectElement('#search-results');

function renderSearchResults() {
  const query = searchInput.value.trim();
  selectElement('#clear-search').hidden = !query;
  if (!query || !state.searchIndex) {
    searchResults.hidden = true;
    return;
  }
  const places = searchPlaces(state.searchIndex, query, 8);
  const resultItems = places.length
    ? html`${places.map(
        (place) =>
          html`<li>
            <button type="button" data-place-id="${place.id}">
              <span class="place-marker category-${place.category}"><span class="marker-dot"></span></span>
              <span
                ><span class="result-name">${place.name}</span><br /><span class="result-category"
                  >${PLACE_CATEGORIES[place.category] || ''}</span
                ></span
              >
            </button>
          </li>`,
      )}`
    : html`<li class="empty-result">Aucun lieu trouvé pour « ${query} ». Essayez un sigle ou un autre nom.</li>`;
  searchResults.innerHTML = html`${resultItems}`;
  searchResults.hidden = false;
}

searchInput.addEventListener('input', renderSearchResults);
searchInput.addEventListener('focus', renderSearchResults);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    searchResults.querySelector('button[data-place-id]')?.click();
  } else if (event.key === 'Escape') {
    searchInput.value = '';
    renderSearchResults();
  }
});
searchResults.addEventListener('click', (event) => {
  const resultButton = event.target.closest('button[data-place-id]');
  if (!resultButton) return;
  const place = findPlaceById(resultButton.dataset.placeId);
  searchResults.hidden = true;
  searchInput.blur();
  if (place) selectPlace(place);
});
selectElement('#clear-search').addEventListener('click', () => {
  searchInput.value = '';
  renderSearchResults();
  searchInput.focus();
});

// ---------- Fiche d'un lieu ----------

function selectPlace(place, { shouldFly = true } = {}) {
  if (state.navigation.isActive) stopGuidance();
  state.selectedPlace = place;
  state.destination = null;
  state.route = null;
  setSourceData('route', EMPTY_COLLECTION);
  searchInput.value = place.name;
  selectElement('#clear-search').hidden = false;
  highlightSelectedMarker();
  renderEntrances();
  if (shouldFly) map.flyTo({ center: getPlacePosition(place), zoom: Math.max(map.getZoom(), 17.5), speed: 1.4 });
  const entranceNotes = place.entrances.filter((entrance) => entrance.note);
  openSheet(html`
    ${sheetHeader(place.name, PLACE_CATEGORIES[place.category] || '')}
    ${place.description ? html`<p>${place.description}</p>` : ''}
    ${place.access ? html`<p><strong>Accès :</strong> ${place.access}</p>` : ''}
    ${
      entranceNotes.length
        ? html`<ul class="entrance-notes">
            ${entranceNotes.map((entrance) => html`<li>${entrance.note}</li>`)}
          </ul>`
        : ''
    }
    ${
      place.entrances.length
        ? ''
        : html`<p class="hint">Entrée non encore relevée : le trajet mène au centre du bâtiment.</p>`
    }
    <div class="actions">
      <button class="button primary wide" data-action="go" type="button">Y aller</button>
      <button class="button" data-action="share" type="button">Partager</button>
    </div>
  `);
}

async function sharePlace(place) {
  const placeUrl = `${location.origin}/?lieu=${encodeURIComponent(place.id)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: place.name, text: `${place.name} sur la carte du campus`, url: placeUrl });
    } else {
      await navigator.clipboard.writeText(placeUrl);
      showToast('Lien copié');
    }
  } catch {
    // Partage annulé par l'utilisateur : rien à faire.
  }
}

// ---------- Point de départ ----------

function describeOrigin(origin) {
  if (!origin) return '';
  if (origin.kind === 'gps') return `Ma position (± ${Math.round(origin.accuracy)} m)`;
  if (origin.kind === 'place') return `Vous êtes ici : ${origin.label}`;
  return 'Point choisi sur la carte';
}

function setOrigin(origin) {
  state.origin = origin;
  const isVisibleMarker = origin && origin.kind !== 'gps';
  setSourceData('origin', isVisibleMarker ? toFeatureCollection([toPointFeature(origin.position)]) : EMPTY_COLLECTION);
}

function startOriginPicking() {
  state.mode = 'pick-origin';
  state.isAwaitingOrigin = false;
  document.body.classList.add('is-picking-point');
  openSheet(sheetHeader('Où êtes-vous ?', "Touchez la carte à l'endroit où vous vous trouvez.", 'Annuler'));
}

function goToPlace(place) {
  state.destination = place;
  highlightSelectedMarker();
  renderEntrances();
  if (state.origin) {
    computeRoute();
    return;
  }
  // Pas encore de point de départ : on tente le GPS, sinon l'utilisateur touche la carte.
  state.isAwaitingOrigin = true;
  openSheet(html`
    ${sheetHeader('Recherche de votre position…', 'Activez la localisation si le téléphone la demande.', 'Annuler')}
    <div class="actions">
      <button class="button" data-action="origin-from-map" type="button">Indiquer ma position sur la carte</button>
    </div>
  `);
  if (!startGps()) startOriginPicking();
  setTimeout(() => {
    if (state.isAwaitingOrigin && !state.origin) {
      state.isAwaitingOrigin = false;
      showToast('Position GPS indisponible pour le moment');
      startOriginPicking();
    }
  }, GPS_WAIT_TIMEOUT_MS);
}

// ---------- Itinéraire ----------

function computeRoute({ shouldFitBounds = true } = {}) {
  const destination = state.destination;
  if (!destination || !state.origin) return;
  const targets = destination.entrances.length
    ? destination.entrances.map((entrance) => [entrance.longitude, entrance.latitude])
    : [getPlacePosition(destination)];
  const foundRoute = findRoute(state.graph, state.origin.position, targets, state.routeOptions);
  if (!foundRoute) {
    state.route = null;
    setSourceData('route', EMPTY_COLLECTION);
    renderRouteSheet(
      state.graph.edges.length
        ? "Aucun chemin connu ne relie votre position à ce lieu avec ces options. Le réseau n'est peut-être pas encore complet dans ce secteur."
        : "Aucun chemin n'a encore été tracé sur la carte. Passez en mode collecte pour en ajouter.",
    );
    return;
  }
  const entrance = destination.entrances[foundRoute.targetIndex];
  const steps = buildRouteSteps(foundRoute.coordinates, {
    places: state.campusMap.places,
    destination,
    entranceNote: [entrance?.note, destination.access].filter(Boolean).join(' · '),
  });
  for (const step of steps) step.along = locateOnLine(foundRoute.coordinates, step.position).along;
  const totalLength = getLineLength(foundRoute.coordinates);
  steps[steps.length - 1].along = totalLength;
  state.route = { ...foundRoute, steps, totalLength };
  setSourceData('route', toFeatureCollection([toLineFeature(foundRoute.coordinates)]));
  renderRouteSheet();
  if (shouldFitBounds && !state.navigation.isActive) fitRoute(foundRoute.coordinates);
}

function fitRoute(coordinates) {
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  const isWideScreen = window.innerWidth >= 760;
  map.fitBounds(
    [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ],
    {
      padding: {
        top: 90,
        left: isWideScreen ? 460 : 40,
        right: 70,
        bottom: isWideScreen ? 40 : selectElement('#sheet').offsetHeight + 24,
      },
      maxZoom: 19,
      duration: 600,
    },
  );
}

function renderRouteSheet(errorMessage) {
  const destination = state.destination;
  const route = state.route;
  const isFarFromNetwork = route && route.startOffset > FAR_FROM_NETWORK_METERS;
  openSheet(html`
    <div class="sheet-handle"></div>
    <div id="guidance"></div>
    <div class="sheet-header">
      <div>
        ${
          route
            ? html`<div class="route-summary">
                ${formatDuration(route.totalLength)} <small>· ${formatDistance(route.totalLength)}</small>
              </div>`
            : html`<h2>Itinéraire</h2>`
        }
        <p class="category-label">vers <strong>${destination.name}</strong></p>
      </div>
      <button class="icon-button" data-action="close" aria-label="Fermer">${CLOSE_ICON}</button>
    </div>
    <div class="route-origin">
      <span>Départ : ${describeOrigin(state.origin)}</span>
      <button class="button small" data-action="change-origin" type="button">Changer</button>
    </div>
    <div id="origin-choices" class="row" hidden>
      <button class="button small" data-action="origin-from-gps" type="button">Ma position GPS</button>
      <button class="button small" data-action="origin-from-map" type="button">Toucher la carte</button>
    </div>
    <div class="route-options">
      <label
        ><input type="checkbox" data-option="avoidStairs" ${state.routeOptions.avoidStairs ? html`checked` : ''} /> Sans
        escaliers</label
      >
      <label
        ><input type="checkbox" data-option="avoidFlood" ${state.routeOptions.avoidFlood ? html`checked` : ''} /> Éviter
        les passages inondables</label
      >
    </div>
    ${errorMessage ? html`<p class="error-message">${errorMessage}</p>` : ''}
    ${
      isFarFromNetwork
        ? html`<p class="hint">
            Vous êtes à ${formatDistance(route.startOffset)} du chemin le plus proche relevé sur la carte.
          </p>`
        : ''
    }
    ${
      route
        ? html`<div class="actions">
              ${
                state.navigation.isActive
                  ? html`<button class="button wide" data-action="stop-guidance" type="button">
                      Arrêter le guidage
                    </button>`
                  : html`<button class="button accent wide" data-action="start-guidance" type="button">
                      Démarrer le guidage
                    </button>`
              }
            </div>
            <ol class="route-steps">
              ${route.steps.map(
                (step, index) =>
                  html`<li data-step-index="${index}">
                    <span class="step-number">${index + 1}</span>
                    <span class="step-text"
                      >${step.text}${step.detail ? html`<br /><span class="step-detail">${step.detail}</span>` : ''}</span
                    >
                    ${step.distance ? html`<span class="step-distance">${formatDistance(step.distance)}</span>` : ''}
                  </li>`,
              )}
            </ol>`
        : ''
    }
  `);
  renderGuidance();
}

// ---------- GPS et guidage ----------

function startGps() {
  if (!('geolocation' in navigator)) {
    showToast('Ce navigateur ne donne pas accès à la position');
    return false;
  }
  if (!window.isSecureContext) {
    showToast('Le GPS exige une adresse https (ou localhost). Voir le README.');
    return false;
  }
  if (state.gps.watchId === null) {
    state.gps.watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handleGpsError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    });
  }
  return true;
}

function stopGpsIfUnused() {
  const isGpsNeeded = state.navigation.isActive || state.gps.subscribers.size || state.isAwaitingOrigin;
  if (state.gps.watchId !== null && !isGpsNeeded) {
    navigator.geolocation.clearWatch(state.gps.watchId);
    state.gps.watchId = null;
  }
}

function handleGpsError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    showToast('Accès à la position refusé. Autorisez-le dans les réglages du navigateur.', 5000);
  }
  if (state.isAwaitingOrigin) {
    state.isAwaitingOrigin = false;
    startOriginPicking();
  }
}

function handlePositionUpdate(geolocationPosition) {
  const position = [geolocationPosition.coords.longitude, geolocationPosition.coords.latitude];
  const accuracy = geolocationPosition.coords.accuracy;
  state.gps.lastFix = { position, accuracy, time: geolocationPosition.timestamp };
  setSourceData(
    'user',
    toFeatureCollection([
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [createCirclePolygon(position, accuracy)] },
      },
      toPointFeature(position),
    ]),
  );
  for (const subscriber of state.gps.subscribers) subscriber(state.gps.lastFix);

  if (state.isAwaitingOrigin) {
    const campusCenter = state.campusMap?.settings?.center || DEFAULT_CENTER;
    if (getDistance(position, campusCenter) > MAX_DISTANCE_FROM_CAMPUS_METERS) {
      state.isAwaitingOrigin = false;
      showToast('Vous semblez loin du campus : indiquez votre point de départ sur la carte.', 5000);
      startOriginPicking();
      return;
    }
    if (accuracy > MIN_ORIGIN_ACCURACY_METERS) return; // on attend une meilleure précision
    state.isAwaitingOrigin = false;
    setOrigin({ kind: 'gps', position, accuracy });
    computeRoute();
    return;
  }
  if (state.origin?.kind === 'gps' && !state.navigation.isActive) state.origin = { kind: 'gps', position, accuracy };
  if (state.navigation.isActive && state.route) followRoute(position, accuracy);
}

function startGuidance() {
  if (!startGps()) return;
  state.navigation = { isActive: true, offRouteCount: 0, isFollowing: true, hasArrived: false };
  selectElement('#locate-button').classList.add('is-following');
  renderRouteSheet();
  if (state.gps.lastFix) followRoute(state.gps.lastFix.position, state.gps.lastFix.accuracy);
}

function stopGuidance() {
  state.navigation.isActive = false;
  selectElement('#locate-button').classList.remove('is-following');
  stopGpsIfUnused();
}

function followRoute(position, accuracy) {
  const route = state.route;
  const location = locateOnLine(route.coordinates, position);
  const tolerance = Math.max(OFF_ROUTE_MIN_METERS, accuracy * 1.2);
  if (location.offset > tolerance) {
    state.navigation.offRouteCount++;
    if (state.navigation.offRouteCount >= 2) {
      state.navigation.offRouteCount = 0;
      setOrigin({ kind: 'gps', position, accuracy });
      computeRoute({ shouldFitBounds: false });
      showToast('Itinéraire recalculé depuis votre position');
      return;
    }
  } else {
    state.navigation.offRouteCount = 0;
  }

  const remaining = Math.max(0, route.totalLength - location.along);
  const routeEnd = route.coordinates[route.coordinates.length - 1];
  const arrivalRadius = Math.max(12, Math.min(accuracy, 25));
  if (!state.navigation.hasArrived && (getDistance(position, routeEnd) <= arrivalRadius || remaining < 8)) {
    state.navigation.hasArrived = true;
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }
  Object.assign(state.navigation, { along: location.along, remaining, accuracy });
  if (state.navigation.isFollowing) {
    const bottomPadding = window.innerWidth >= 760 ? 0 : selectElement('#sheet').offsetHeight;
    map.easeTo({
      center: position,
      zoom: Math.max(map.getZoom(), 18),
      padding: { top: 80, bottom: bottomPadding, left: 0, right: 0 },
      duration: 500,
    });
  }
  renderGuidance();
}

function renderGuidance() {
  const guidanceElement = selectElement('#guidance');
  if (!guidanceElement) return;
  const route = state.route;
  const navigation = state.navigation;
  if (!navigation.isActive || !route) {
    guidanceElement.innerHTML = '';
    return;
  }
  if (navigation.along === undefined) {
    guidanceElement.innerHTML = html`<div class="guidance"><div class="guidance-next">En attente du GPS…</div></div>`;
    return;
  }
  const arrivalStep = route.steps[route.steps.length - 1];
  if (navigation.hasArrived) {
    guidanceElement.innerHTML = html`<div class="guidance is-arrived">
      <div class="guidance-next">${arrivalStep.text}</div>
      ${arrivalStep.detail ? html`<div class="guidance-remaining">${arrivalStep.detail}</div>` : ''}
    </div>`;
    return;
  }
  const nextStepIndex = route.steps.findIndex((step) => step.kind !== 'departure' && step.along > navigation.along + 3);
  const nextStep = route.steps[nextStepIndex] || arrivalStep;
  const distanceToNextStep = Math.max(0, nextStep.along - navigation.along);
  const nextLabel = nextStep.kind === 'arrival' ? 'Arrivée' : nextStep.text;
  guidanceElement.innerHTML = html`<div class="guidance">
    <div class="guidance-next">${nextLabel} dans ${formatDistance(distanceToNextStep)}</div>
    <div class="guidance-remaining">
      ${nextStep.detail ? `${nextStep.detail} · ` : ''}reste ${formatDistance(navigation.remaining)} ·
      ${formatDuration(navigation.remaining)} · GPS ± ${Math.round(navigation.accuracy)} m
    </div>
  </div>`;
  document.querySelectorAll('.route-steps li').forEach((stepElement) => {
    stepElement.classList.toggle('is-current', Number(stepElement.dataset.stepIndex) === nextStepIndex);
  });
}

// ---------- Actions ----------

function resetView() {
  if (state.navigation.isActive) stopGuidance();
  state.selectedPlace = null;
  state.destination = null;
  state.route = null;
  state.isAwaitingOrigin = false;
  if (state.mode === 'pick-origin') state.mode = null;
  document.body.classList.remove('is-picking-point');
  setSourceData('route', EMPTY_COLLECTION);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  highlightSelectedMarker();
  renderEntrances();
  closeSheet();
  stopGpsIfUnused();
}

const sheetActions = {
  close: resetView,
  go: () => goToPlace(state.selectedPlace),
  share: () => sharePlace(state.selectedPlace),
  'change-origin': () => {
    const choices = selectElement('#origin-choices');
    choices.hidden = !choices.hidden;
  },
  'origin-from-map': startOriginPicking,
  'origin-from-gps': () => {
    setOrigin(null);
    goToPlace(state.destination);
  },
  'start-guidance': startGuidance,
  'stop-guidance': () => {
    stopGuidance();
    renderRouteSheet();
  },
};

selectElement('#sheet').addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) sheetActions[actionButton.dataset.action]?.();
});

selectElement('#sheet').addEventListener('change', (event) => {
  const option = event.target.dataset.option;
  if (!option) return;
  state.routeOptions[option] = event.target.checked;
  computeRoute({ shouldFitBounds: false });
});

map.on('click', (event) => {
  if (Date.now() - state.lastMarkerClickTime < MARKER_CLICK_GUARD_MS) return;
  const position = [event.lngLat.lng, event.lngLat.lat];
  if (state.hooks.onMapClick && state.hooks.onMapClick(event, position)) return;
  if (state.mode === 'pick-origin') {
    state.mode = null;
    document.body.classList.remove('is-picking-point');
    setOrigin({ kind: 'point', position });
    if (state.destination) computeRoute();
    else closeSheet();
    return;
  }
  searchResults.hidden = true;
});

map.on('dragstart', (event) => {
  if (event.originalEvent && state.navigation.isActive) state.navigation.isFollowing = false;
});

map.on('zoom', () => map.getContainer().classList.toggle('shows-labels', map.getZoom() >= LABELS_MIN_ZOOM));

selectElement('#layer-button').addEventListener('click', () => toggleSatellite());

selectElement('#locate-button').addEventListener('click', () => {
  if (state.navigation.isActive) state.navigation.isFollowing = true;
  if (state.gps.lastFix) {
    map.flyTo({ center: state.gps.lastFix.position, zoom: Math.max(map.getZoom(), 18) });
    return;
  }
  if (!startGps()) return;
  const centerOnFirstFix = (fix) => {
    state.gps.subscribers.delete(centerOnFirstFix);
    map.flyTo({ center: fix.position, zoom: Math.max(map.getZoom(), 18) });
    showToast(`Précision : ± ${Math.round(fix.accuracy)} m`);
  };
  state.gps.subscribers.add(centerOnFirstFix);
});

selectElement('#menu-button').addEventListener('click', () => selectElement('#menu-dialog').showModal());
document.querySelectorAll('[data-close-dialog]').forEach((closeButton) => {
  closeButton.addEventListener('click', () => closeButton.closest('dialog').close());
});

// ---------- Démarrage ----------

function applyUrlParameters() {
  const parameters = new URLSearchParams(location.search);
  const currentPlace = parameters.get('ici') && findPlaceById(parameters.get('ici'));
  const sharedPlace = parameters.get('lieu') && findPlaceById(parameters.get('lieu'));
  if (currentPlace) {
    setOrigin({ kind: 'place', position: getPlacePosition(currentPlace), label: currentPlace.name });
    map.jumpTo({ center: getPlacePosition(currentPlace), zoom: 18 });
    showToast(`Vous êtes ici : ${currentPlace.name}. Cherchez votre destination.`, 5000);
  }
  if (sharedPlace) selectPlace(sharedPlace);
  if (currentPlace || sharedPlace) history.replaceState(null, '', '/');
}

map.on('load', async () => {
  addMapLayers();
  await loadCampusMap();
  applyUrlParameters();
  initCollectMode({
    map,
    state,
    showToast,
    reloadCampusMap: loadCampusMap,
    renderEntrances,
    toggleSatellite,
    startGps,
    stopGpsIfUnused,
    resetView,
    setSourceData,
    toFeatureCollection,
    toLineFeature,
    toPointFeature,
  });
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
