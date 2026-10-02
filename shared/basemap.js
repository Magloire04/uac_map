/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fond de carte auto-hébergé : zone couverte par public/basemap/campus.pmtiles, style de la carte et extraction.
// Le plan est servi par le site ; seule l'imagerie satellite, réservée aux modes d'édition, vient d'Esri.

// Ouest, sud, est, nord : le périmètre du campus prolongé d'environ 3 km de chaque côté.
export const BASEMAP_BOUNDS = [2.3104, 6.3822, 2.3736, 6.45];
// La carte ne sort pas de la zone : en dessous du zoom 12, rien n'est affichable. Le zoom 11 laisse une marge, et
// les zooms plus petits (un tiers du fichier) ne sont pas extraits.
export const BASEMAP_MIN_ZOOM = 11;
export const BASEMAP_MAX_ZOOM = 15;
export const BASEMAP_ARCHIVE_URL = '/basemap/campus.pmtiles';
export const BASEMAP_ARCHIVE_KEY = 'campus';
export const BASEMAP_SOURCE_ID = 'protomaps';
export const BASEMAP_FLAVOR = 'light';
export const BASEMAP_LANGUAGE = 'fr';

const PROTOMAPS_BUILDS_URL = 'https://build.protomaps.com';
const POINTS_OF_INTEREST_LAYER = 'pois';
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const BASEMAP_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';
const SATELLITE_ATTRIBUTION = 'Imagerie © Esri, Maxar, Earthstar Geographics';

// Les lieux viennent de l'application, relus par l'équipe : ceux d'OpenStreetMap feraient doublon.
export const withoutPointsOfInterest = (layers) =>
  layers.filter((layer) => layer['source-layer'] !== POINTS_OF_INTEREST_LAYER);

// Style MapLibre : couches Protomaps (plan), puis la couche satellite, cachée par défaut. Les couches de
// l'application s'ajoutent par-dessus au chargement de la carte.
export function createMapStyle({ basemapLayers, origin }) {
  return {
    version: 8,
    glyphs: `${origin}/basemap/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/basemap/sprites/${BASEMAP_FLAVOR}`,
    sources: {
      [BASEMAP_SOURCE_ID]: {
        type: 'vector',
        url: `pmtiles://${BASEMAP_ARCHIVE_KEY}`,
        attribution: BASEMAP_ATTRIBUTION,
      },
      satellite: {
        type: 'raster',
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: 18,
        attribution: SATELLITE_ATTRIBUTION,
      },
    },
    layers: [
      ...withoutPointsOfInterest(basemapLayers),
      { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
    ],
  };
}

// Arguments de `pmtiles extract` : la zone, extraite du build quotidien de Protomaps (données OpenStreetMap).
export function createExtractArguments(buildDate, outputPath) {
  if (!/^\d{8}$/.test(buildDate)) throw new Error('Date de build attendue au format AAAAMMJJ');
  return [
    'extract',
    `${PROTOMAPS_BUILDS_URL}/${buildDate}.pmtiles`,
    outputPath,
    `--bbox=${BASEMAP_BOUNDS.join(',')}`,
    `--minzoom=${BASEMAP_MIN_ZOOM}`,
    `--maxzoom=${BASEMAP_MAX_ZOOM}`,
  ];
}
