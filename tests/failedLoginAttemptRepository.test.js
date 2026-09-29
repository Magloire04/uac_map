/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createClientDigest } from '../server/adminSessions.js';
import {
  clearFailedAttempts,
  FAILED_ATTEMPT_WINDOW_MS,
  isClientBlocked,
  recordFailedAttempt,
} from '../server/database/failedLoginAttemptRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
const CLIENT = createClientDigest('203.0.113.5', ADMIN_TOKEN);
const OTHER_CLIENT = createClientDigest('203.0.113.6', ADMIN_TOKEN);
const START = new Date('2026-09-29T08:00:00.000Z');
const windowEnd = new Date(START.getTime() + FAILED_ATTEMPT_WINDOW_MS);
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

async function recordFailures(count, client = CLIENT, now = START) {
  await database.execute('DELETE FROM failed_login_attempts');
  for (let attempt = 0; attempt < count; attempt++) await recordFailedAttempt(database, client, now);
}

databaseTest('bloque un client au dixième échec, pas avant', async () => {
  await recordFailures(9);
  assert.equal(await isClientBlocked(database, CLIENT, START), false);
  await recordFailedAttempt(database, CLIENT, START);
  assert.equal(await isClientBlocked(database, CLIENT, START), true);
});

databaseTest('débloque le client à la fin de la fenêtre de 15 minutes et repart de zéro', async () => {
  await recordFailures(10);
  assert.equal(await isClientBlocked(database, CLIENT, windowEnd), false);
  await recordFailedAttempt(database, CLIENT, windowEnd);
  const [rows] = await database.execute('SELECT failure_count FROM failed_login_attempts');
  assert.equal(rows[0].failure_count, 1);
});

databaseTest('efface le compteur après une connexion réussie', async () => {
  await recordFailures(10);
  await clearFailedAttempts(database, CLIENT);
  assert.equal(await isClientBlocked(database, CLIENT, START), false);
});

databaseTest('garde un compteur par client', async () => {
  await recordFailures(10);
  assert.equal(await isClientBlocked(database, OTHER_CLIENT, START), false);
});

databaseTest('ne stocke jamais l’adresse du client en clair', async () => {
  await recordFailures(1);
  const [rows] = await database.execute('SELECT client_digest FROM failed_login_attempts');
  assert.equal(rows[0].client_digest.length, 32);
  assert.ok(!rows[0].client_digest.includes(Buffer.from('203.0.113.5')));
});
