/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Régénère le fond de carte auto-hébergé : extrait PMTiles du campus et de 3 km autour, polices et icônes.
//   npm run build-basemap                      build Protomaps de la veille
//   npm run build-basemap -- --date 20260930   build d'un jour donné (les builds ne restent que quelques jours en ligne)
// Demande l'outil pmtiles (https://github.com/protomaps/go-pmtiles/releases), dans le PATH ou indiqué par
// PMTILES_BIN, et un accès à Internet. À lancer à la main sur un poste de développement, jamais en production.
// Après une régénération, changer la version du cache de l'appli dans public/sw.js.

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createExtractArguments } from '../shared/basemap.js';

const BASEMAP_DIRECTORY = fileURLToPath(new URL('../public/basemap/', import.meta.url));
const ASSETS_URL =
  'https://raw.githubusercontent.com/protomaps/basemaps-assets/028c18f713baecad011301ff7a69acc39bcc2ae7';
const ICONS_LICENSE_URL =
  'https://raw.githubusercontent.com/tangrams/icons/92510779634f4a006c61ea70e50cb8c52c765a81/LICENSE.md';
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
// Latin et accents, latin étendu, lettres fon et yoruba (ɔ, ɛ), accents combinés, ẹ et ọ, ponctuation.
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447'];
const SPRITE_FILES = ['light.json', 'light.png', 'light@2x.json', 'light@2x.png'];
const DAY_MS = 24 * 60 * 60 * 1000;

function readBuildDate() {
  const commandArguments = process.argv.slice(2);
  const dateIndex = commandArguments.indexOf('--date');
  if (dateIndex !== -1) return commandArguments[dateIndex + 1] ?? '';
  return new Date(Date.now() - DAY_MS).toISOString().slice(0, 10).replaceAll('-', '');
}

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} a répondu ${response.status}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function measureDirectory(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;

async function buildBasemap() {
  const buildDate = readBuildDate();
  const archivePath = join(BASEMAP_DIRECTORY, 'campus.pmtiles');
  await mkdir(BASEMAP_DIRECTORY, { recursive: true });

  console.log(`Extraction du build Protomaps du ${buildDate}…`);
  try {
    await promisify(execFile)(process.env.PMTILES_BIN || 'pmtiles', createExtractArguments(buildDate, archivePath));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('outil pmtiles introuvable : installez-le ou indiquez son chemin dans PMTILES_BIN', {
        cause: error,
      });
    }
    throw new Error(`pmtiles extract a échoué (build ${buildDate} encore en ligne ?) : ${error.message}`, {
      cause: error,
    });
  }

  console.log('Téléchargement des polices et des icônes…');
  for (const font of FONTS) {
    for (const range of GLYPH_RANGES) {
      await download(
        `${ASSETS_URL}/fonts/${encodeURIComponent(font)}/${range}.pbf`,
        join(BASEMAP_DIRECTORY, 'fonts', font, `${range}.pbf`),
      );
    }
  }
  await download(`${ASSETS_URL}/fonts/OFL.txt`, join(BASEMAP_DIRECTORY, 'fonts', 'OFL.txt'));
  for (const file of SPRITE_FILES) {
    await download(`${ASSETS_URL}/sprites/v4/${file}`, join(BASEMAP_DIRECTORY, 'sprites', file));
  }
  await download(ICONS_LICENSE_URL, join(BASEMAP_DIRECTORY, 'sprites', 'LICENSE.md'));

  console.log(`Fond de carte : ${formatMegabytes((await stat(archivePath)).size)}`);
  console.log(`Polices : ${formatMegabytes(await measureDirectory(join(BASEMAP_DIRECTORY, 'fonts')))}`);
  console.log(`Icônes : ${formatMegabytes(await measureDirectory(join(BASEMAP_DIRECTORY, 'sprites')))}`);
}

try {
  await buildBasemap();
} catch (error) {
  console.error(`Échec : ${error.message}`);
  process.exitCode = 1;
}
