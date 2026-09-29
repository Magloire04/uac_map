/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { CampusMapStore } from './store.js';
import { createApp } from './app.js';
import { buildDemoCampusMap } from './demo.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIRECTORY = join(PROJECT_ROOT, 'data');
const DATA_FILE = resolve(process.env.DATA_FILE || join(DATA_DIRECTORY, 'campus.json'));
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

async function isExistingFile(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Jeton du mode collecte : variable ADMIN_TOKEN, sinon généré au premier lancement et conservé dans data/.admin-token.
async function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const tokenFile = join(DATA_DIRECTORY, '.admin-token');
  if (await isExistingFile(tokenFile)) return (await readFile(tokenFile, 'utf8')).trim();
  const adminToken = randomBytes(18).toString('base64url');
  await mkdir(DATA_DIRECTORY, { recursive: true });
  await writeFile(tokenFile, `${adminToken}\n`, { mode: 0o600 });
  return adminToken;
}

// Certificat auto-signé, pour tester la géolocalisation depuis un téléphone du même réseau Wi-Fi
// (les navigateurs refusent le GPS sur une page http:// autre que localhost).
async function loadCertificate(addresses) {
  const certificateDirectory = join(DATA_DIRECTORY, 'cert');
  const keyFile = join(certificateDirectory, 'key.pem');
  const certificateFile = join(certificateDirectory, 'cert.pem');
  if ((await isExistingFile(keyFile)) && (await isExistingFile(certificateFile))) {
    return { key: await readFile(keyFile), cert: await readFile(certificateFile) };
  }
  const { default: selfsigned } = await import('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'uac-carte.local' }], {
    days: 825,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          ...addresses.map((address) => ({ type: 7, ip: address })),
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  await mkdir(certificateDirectory, { recursive: true });
  await writeFile(keyFile, pems.private, { mode: 0o600 });
  await writeFile(certificateFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function getLocalNetworkAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((networkInterface) => networkInterface && networkInterface.family === 'IPv4' && !networkInterface.internal)
    .map((networkInterface) => networkInterface.address);
}

async function startServer() {
  const isFirstRun = !(await isExistingFile(DATA_FILE));
  const store = new CampusMapStore(DATA_FILE);
  await store.load();
  if (isFirstRun) {
    await store.update((campusMap) => Object.assign(campusMap, buildDemoCampusMap()));
    console.log('Premier lancement : données de démonstration chargées (npm run reset pour repartir de zéro).');
  }

  const adminToken = await loadAdminToken();
  const app = createApp({ store, adminToken, publicUrl: process.env.PUBLIC_URL || '' });
  const addresses = getLocalNetworkAddresses();

  createHttpServer(app).listen(PORT, '0.0.0.0', () => {
    console.log(`\nCarte UAC prête : http://localhost:${PORT}`);
    for (const address of addresses) console.log(`  sur le réseau local : http://${address}:${PORT}`);
    // Le jeton n'est jamais écrit dans les journaux : on indique seulement où le trouver.
    if (!process.env.ADMIN_TOKEN)
      console.log(`Jeton du mode collecte : fichier ${join(DATA_DIRECTORY, '.admin-token')}`);
    console.log(`Données : ${DATA_FILE}\n`);
  });

  if (process.env.HTTPS_ENABLED === 'true') {
    const credentials = await loadCertificate(addresses);
    createHttpsServer(credentials, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      for (const address of addresses) console.log(`HTTPS (GPS sur téléphone) : https://${address}:${HTTPS_PORT}`);
      console.log('Le navigateur affichera un avertissement de certificat : acceptez-le une fois.\n');
    });
  }
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
