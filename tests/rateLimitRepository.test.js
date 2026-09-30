/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reserveRateLimit } from '../server/database/rateLimitRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const SUBJECT = createHash('sha256').update('sujet-de-test').digest();
const LIMIT = { maxCount: 3, windowMs: 60 * 60 * 1000 };
const START = new Date('2026-09-30T08:00:00.000Z');
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const clearLimits = () => database.execute('DELETE FROM rate_limits');

databaseTest("autorise jusqu'à la limite puis refuse", async () => {
  await clearLimits();
  const outcomes = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    outcomes.push(await reserveRateLimit(database, 'essai', SUBJECT, LIMIT, START));
  }
  assert.deepEqual(outcomes, [true, true, true, false]);
});

databaseTest('reste exacte sous des réservations parallèles', async () => {
  await clearLimits();
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () => reserveRateLimit(database, 'essai', SUBJECT, LIMIT, START)),
  );
  assert.equal(outcomes.filter(Boolean).length, 3);
});

databaseTest('repart de zéro à la fin de la fenêtre', async () => {
  await clearLimits();
  for (let attempt = 0; attempt < 4; attempt++) await reserveRateLimit(database, 'essai', SUBJECT, LIMIT, START);
  const windowEnd = new Date(START.getTime() + LIMIT.windowMs);
  assert.equal(await reserveRateLimit(database, 'essai', SUBJECT, LIMIT, windowEnd), true);
});

databaseTest('compte chaque nature de limite séparément', async () => {
  await clearLimits();
  for (let attempt = 0; attempt < 3; attempt++) await reserveRateLimit(database, 'essai', SUBJECT, LIMIT, START);
  assert.equal(await reserveRateLimit(database, 'autre', SUBJECT, LIMIT, START), true);
});
