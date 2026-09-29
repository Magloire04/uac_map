/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stockage dans un fichier JSON unique. Suffisant pour un prototype mono-serveur :
// écritures sérialisées et atomiques (fichier temporaire puis renommage).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmptyCampusMap, DEFAULT_CENTER, DEFAULT_ZOOM, SCHEMA_VERSION } from './campusMapDefaults.js';

export { createEmptyCampusMap, DEFAULT_CENTER, DEFAULT_ZOOM, SCHEMA_VERSION };

// Conversion du format du premier prototype (version 1, champs en français) vers la version 2.
const LEGACY_CATEGORIES = {
  amphi: 'lecture-hall',
  salle: 'classroom',
  faculte: 'faculty',
  bibliotheque: 'library',
  restauration: 'food',
  sante: 'health',
  logement: 'housing',
  culte: 'worship',
  portail: 'gate',
  repere: 'landmark',
  autre: 'other',
};
const LEGACY_PATH_TYPES = {
  allee: 'footpath',
  route: 'road',
  piste: 'track',
  couloir: 'corridor',
  escaliers: 'stairs',
};

export function migrateCampusMap(stored) {
  if (!stored || stored.version === SCHEMA_VERSION) return stored;
  const migrated = createEmptyCampusMap();
  const legacySettings = stored.meta || {};
  migrated.settings = {
    ...migrated.settings,
    center: legacySettings.center || DEFAULT_CENTER,
    zoom: legacySettings.zoom || DEFAULT_ZOOM,
    isDemo: Boolean(legacySettings.demo),
    updatedAt: legacySettings.updatedAt || migrated.settings.updatedAt,
  };
  migrated.places = (stored.places || []).map((place) => ({
    id: place.id,
    name: place.name,
    category: LEGACY_CATEGORIES[place.category] || place.category || 'other',
    aliases: place.aliases || [],
    description: place.description || '',
    access: place.access || '',
    longitude: place.lon,
    latitude: place.lat,
    entrances: (place.entrances || []).map((entrance) => ({
      longitude: entrance.lon,
      latitude: entrance.lat,
      note: entrance.note || '',
    })),
  }));
  migrated.paths = (stored.paths || []).map((path) => ({
    id: path.id,
    type: LEGACY_PATH_TYPES[path.type] || path.type || 'footpath',
    name: path.name || '',
    isFloodProne: Boolean(path.inondable),
    coordinates: path.coords || [],
  }));
  return migrated;
}

export class CampusMapStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.campusMap = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.campusMap = migrateCampusMap(stored);
      if (stored.version !== SCHEMA_VERSION) await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.campusMap = createEmptyCampusMap();
      await this.persist();
    }
    return this.campusMap;
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.campusMap, null, 1));
    await rename(temporaryPath, this.filePath);
  }

  // Toute modification passe par ici : une seule écriture à la fois.
  update(mutateCampusMap) {
    const pendingWrite = this.writeQueue.then(async () => {
      const outcome = await mutateCampusMap(this.campusMap);
      this.campusMap.settings.updatedAt = new Date().toISOString();
      await this.persist();
      return outcome;
    });
    this.writeQueue = pendingWrite.catch(() => {});
    return pendingWrite;
  }

  static generateId(prefix) {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }
}
