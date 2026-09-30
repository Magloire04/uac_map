/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Importe le contour du campus depuis OpenStreetMap : il sert de périmètre à la contribution ouverte.
// Les lieux et les chemins ne changent pas.
//   npm run import-perimeter                       interroge Overpass (connexion Internet requise)
//   npm run import-perimeter -- --fichier x.json   utilise une réponse Overpass déjà téléchargée
//                                                  (data/osm-brut.json laissé par import-osm convient)

import { readFile } from 'node:fs/promises';
import { extractPerimeter, PERIMETER_QUERY } from '../server/openStreetMapImport.js';
import { setPerimeter } from '../server/database/campusMapRepository.js';
import { logSecurityEvent } from '../server/securityLog.js';
import { runWithDatabase } from './runWithDatabase.js';

const commandArguments = process.argv.slice(2);
const inputFile = commandArguments.includes('--fichier')
  ? commandArguments[commandArguments.indexOf('--fichier') + 1]
  : null;
const overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

async function fetchOverpassResponse() {
  console.log(`Interrogation d'Overpass (${overpassUrl})…`);
  const response = await fetch(overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'uac-map/0.3' },
    body: new URLSearchParams({ data: PERIMETER_QUERY }),
  });
  if (!response.ok) {
    throw new Error(
      `Overpass a répondu ${response.status}. Réessayez plus tard ou changez de serveur via OVERPASS_URL.`,
    );
  }
  return response.json();
}

await runWithDatabase(async (database) => {
  const overpassResponse = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : await fetchOverpassResponse();
  const perimeter = extractPerimeter(overpassResponse);
  if (!perimeter) {
    throw new Error("Contour du campus absent ou invalide : polygone fermé d'au moins 4 points attendu");
  }
  await setPerimeter(database, perimeter);
  logSecurityEvent('perimeter_imported', { pointCount: perimeter.length });
  console.log(`Périmètre enregistré : ${perimeter.length} points.`);
});
