/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createReviewer,
  findActiveReviewerByToken,
  listReviewers,
  revokeReviewer,
} from '../server/database/reviewerRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const NOW = new Date('2026-09-30T08:00:00.000Z');
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const clearReviewers = async () => {
  await database.execute('DELETE FROM admin_sessions');
  await database.execute('DELETE FROM reviewers');
};

databaseTest('crée un relecteur dont seul le jeton affiché permet de le retrouver', async () => {
  await clearReviewers();
  const { reviewer, token } = await createReviewer(database, 'Aïcha', NOW);
  assert.ok(token.length >= 40);
  assert.deepEqual(reviewer, {
    id: reviewer.id,
    name: 'Aïcha',
    isActive: true,
    createdAt: NOW.toISOString(),
    revokedAt: null,
  });
  assert.equal((await findActiveReviewerByToken(database, token)).id, reviewer.id);
  assert.equal(await findActiveReviewerByToken(database, 'mauvais-jeton'), null);
  const [rows] = await database.execute('SELECT token_digest FROM reviewers');
  assert.ok(!rows[0].token_digest.includes(Buffer.from(token)));
});

databaseTest('révoque un relecteur et ferme ses sessions', async () => {
  await clearReviewers();
  const { reviewer, token } = await createReviewer(database, 'Koffi', NOW);
  await database.execute(
    "INSERT INTO admin_sessions (session_digest, token_fingerprint, expires_at, created_at, actor_kind, reviewer_id) VALUES (?, ?, ?, ?, 'reviewer', ?)",
    [
      createHash('sha256').update('session').digest(),
      createHash('sha256').update('empreinte').digest(),
      new Date('2026-09-30T20:00:00.000Z'),
      NOW,
      reviewer.id,
    ],
  );
  assert.equal(await revokeReviewer(database, reviewer.id, NOW), true);
  assert.equal(await revokeReviewer(database, reviewer.id, NOW), false);
  assert.equal(await findActiveReviewerByToken(database, token), null);
  const [sessions] = await database.execute('SELECT COUNT(*) AS total FROM admin_sessions');
  assert.equal(Number(sessions[0].total), 0);
  assert.equal((await listReviewers(database, { page: 1, limit: 20 })).items[0].revokedAt, NOW.toISOString());
});
