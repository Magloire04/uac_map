/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Démarrage du serveur : configuration, contrôle de la base, initialisation de la carte, puis écoute HTTP
// (et HTTPS auto-signé en local). Toute anomalie de configuration arrête le démarrage avec un message clair.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ConfigurationError, readServerConfiguration } from './configuration.js';
import { createDatabasePool } from './database/connection.js';
import { getPendingMigrations } from './database/migrations.js';
import { initialiseCampusMap } from './database/campusMapRepository.js';
import { buildDemoCampusMap } from './demo.js';
import { createApp } from './app.js';

const DATA_DIRECTORY = fileURLToPath(new URL('../data/', import.meta.url));

async function isExistingFile(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Hors production et sans ADMIN_TOKEN : jeton généré au premier lancement et conservé dans data/.admin-token.
async function loadLocalAdminToken() {
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

async function assertDatabaseReady(database, { host, port, database: databaseName }) {
  let pendingMigrations;
  try {
    pendingMigrations = await getPendingMigrations(database);
  } catch (error) {
    throw new ConfigurationError(
      `Base de données injoignable (${host}:${port}, base ${databaseName}) : ${error.code ?? error.message}`,
    );
  }
  if (pendingMigrations.length) {
    throw new ConfigurationError(
      `Schéma de la base en retard : lancez npm run database:migrate (${pendingMigrations.join(', ')})`,
    );
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

export async function startServer({ environment = process.env, log = console.log } = {}) {
  const configuration = readServerConfiguration(environment);
  const database = createDatabasePool(configuration.database);
  try {
    await assertDatabaseReady(database, configuration.database);
    const initialisation = await initialiseCampusMap(database, {
      isProduction: configuration.isProduction,
      buildDemoCampusMap,
    });
    if (initialisation === 'demo') {
      log('Premier lancement : données de démonstration chargées (npm run reset -- --oui pour repartir de zéro).');
    }
    const adminToken = configuration.adminToken ?? (await loadLocalAdminToken());
    const app = createApp({
      database,
      adminToken,
      publicUrl: configuration.publicUrl,
      trustProxy: configuration.trustProxy,
    });
    const addresses = getLocalNetworkAddresses();
    const servers = [await listen(createHttpServer(app), configuration.port)];
    const { port } = servers[0].address();
    log(`\nCarte UAC prête : http://localhost:${port}`);
    for (const address of addresses) log(`  sur le réseau local : http://${address}:${port}`);
    // Le jeton n'est jamais écrit dans les journaux : on indique seulement où le trouver.
    if (!configuration.adminToken) log(`Jeton du mode collecte : fichier ${join(DATA_DIRECTORY, '.admin-token')}`);
    const { host, port: databasePort, database: databaseName } = configuration.database;
    log(`Base : ${databaseName} sur ${host}:${databasePort}\n`);
    if (configuration.isHttpsEnabled) {
      const credentials = await loadCertificate(addresses);
      servers.push(await listen(createHttpsServer(credentials, app), configuration.httpsPort));
      for (const address of addresses) log(`HTTPS (GPS sur téléphone) : https://${address}:${configuration.httpsPort}`);
      log('Le navigateur affichera un avertissement de certificat : acceptez-le une fois.\n');
    }
    return {
      port,
      close: async () => {
        await Promise.all(servers.map(closeServer));
        await database.end();
      },
    };
  } catch (error) {
    await database.end();
    throw error;
  }
}
