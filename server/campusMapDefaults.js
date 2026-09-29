/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Valeurs par défaut de la carte. SCHEMA_VERSION est la version du format renvoyé par l'API.

export const SCHEMA_VERSION = 2;
export const DEFAULT_CAMPUS_NAME = "Université d'Abomey-Calavi";
export const DEFAULT_CENTER = [2.341985, 6.416091];
export const DEFAULT_ZOOM = 16;

export function createEmptyCampusMap(now = new Date()) {
  return {
    version: SCHEMA_VERSION,
    settings: {
      name: DEFAULT_CAMPUS_NAME,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      isDemo: false,
      updatedAt: now.toISOString(),
    },
    places: [],
    paths: [],
  };
}
