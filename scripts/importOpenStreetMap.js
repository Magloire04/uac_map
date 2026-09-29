/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Importe les chemins, lieux nommés et entrées déjà présents dans OpenStreetMap pour le campus.
//   npm run import-osm                       interroge Overpass (connexion Internet requise)
//   npm run import-osm -- --fichier x.json   utilise un export Overpass déjà téléchargé
//   npm run import-osm -- --remplacer        remplace toutes les données au lieu de fusionner

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { convertOverpassResponse, OVERPASS_QUERY } from '../server/openStreetMapImport.js';
import { rewriteCampusMap } from '../server/database/campusMapRepository.js';
import { runWithDatabase } from './runWithDatabase.js';

const DATA_DIRECTORY = fileURLToPath(new URL('../data/', import.meta.url));
const commandArguments = process.argv.slice(2);
const inputFile = commandArguments.includes('--fichier')
  ? commandArguments[commandArguments.indexOf('--fichier') + 1]
  : null;
const isReplacing = commandArguments.includes('--remplacer');
const overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

async function fetchOverpassResponse() {
  console.log(`Interrogation d'Overpass (${overpassUrl})…`);
  const response = await fetch(overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'uac-map/0.2' },
    body: new URLSearchParams({ data: OVERPASS_QUERY }),
  });
  if (!response.ok) {
    throw new Error(
      `Overpass a répondu ${response.status}. Réessayez plus tard ou changez de serveur via OVERPASS_URL.`,
    );
  }
  const overpassResponse = await response.json();
  const rawFile = join(DATA_DIRECTORY, 'osm-brut.json');
  await mkdir(DATA_DIRECTORY, { recursive: true });
  await writeFile(rawFile, JSON.stringify(overpassResponse));
  console.log(`Réponse brute conservée dans ${rawFile}`);
  return overpassResponse;
}

await runWithDatabase(async (database) => {
  const overpassResponse = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : await fetchOverpassResponse();
  const imported = convertOverpassResponse(overpassResponse);
  await rewriteCampusMap(database, (campusMap) => {
    const keepExisting = (items) =>
      isReplacing
        ? []
        : items.filter(
            (item) => !item.id.startsWith('osm_') && !(campusMap.settings.isDemo && item.id.startsWith('demo_')),
          );
    return {
      ...campusMap,
      paths: [...keepExisting(campusMap.paths), ...imported.paths],
      places: [...keepExisting(campusMap.places), ...imported.places],
      settings: { ...campusMap.settings, isDemo: false, ...(imported.center ? { center: imported.center } : {}) },
    };
  });
  const { counts } = imported;
  console.log(`Import terminé : ${counts.paths} chemins, ${counts.places} lieux nommés, ${counts.entrances} entrées.`);
  console.log('Complétez et corrigez ensuite en mode collecte.');
});
