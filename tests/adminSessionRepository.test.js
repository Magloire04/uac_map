/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createSessionDigest, createTokenFingerprint, SESSION_DURATION_MS } from '../server/adminSessions.js';
import {
  createAdminSession,
  deleteAdminSession,
  findAdminSessionExpiration,
} from '../server/database/adminSessionRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const TOKEN_FINGERPRINT = createTokenFingerprint('jeton-de-test-1234');
const OPENED_AT = new Date('2026-09-29T08:00:00.000Z');
const later = (milliseconds) => new Date(OPENED_AT.getTime() + milliseconds);
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const clearSessions = () => database.execute('DELETE FROM admin_sessions');

databaseTest('ne stocke que l’empreinte de l’identifiant de session', async () => {
  await clearSessions();
  const { sessionId } = await createAdminSession(database, TOKEN_FINGERPRINT, OPENED_AT);
  const [rows] = await database.execute('SELECT session_digest FROM admin_sessions');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].session_digest, createSessionDigest(sessionId));
  assert.ok(!rows[0].session_digest.includes(Buffer.from(sessionId)));
});

databaseTest('reste valide 12 heures puis expire', async () => {
  await clearSessions();
  const { sessionId, expiresAt } = await createAdminSession(database, TOKEN_FINGERPRINT, OPENED_AT);
  assert.equal(expiresAt.toISOString(), later(SESSION_DURATION_MS).toISOString());
  const stillValid = await findAdminSessionExpiration(
    database,
    sessionId,
    TOKEN_FINGERPRINT,
    later(SESSION_DURATION_MS - 1),
  );
  assert.equal(stillValid.toISOString(), expiresAt.toISOString());
  assert.equal(
    await findAdminSessionExpiration(database, sessionId, TOKEN_FINGERPRINT, later(SESSION_DURATION_MS)),
    null,
  );
});

databaseTest('refuse une session ouverte avec un autre jeton', async () => {
  await clearSessions();
  const { sessionId } = await createAdminSession(database, TOKEN_FINGERPRINT, OPENED_AT);
  const otherFingerprint = createTokenFingerprint('autre-jeton-de-test-99');
  assert.equal(await findAdminSessionExpiration(database, sessionId, otherFingerprint, OPENED_AT), null);
});

databaseTest('supprime la session à la déconnexion', async () => {
  await clearSessions();
  const { sessionId } = await createAdminSession(database, TOKEN_FINGERPRINT, OPENED_AT);
  await deleteAdminSession(database, sessionId);
  assert.equal(await findAdminSessionExpiration(database, sessionId, TOKEN_FINGERPRINT, OPENED_AT), null);
});

databaseTest('efface les sessions expirées à chaque ouverture', async () => {
  await clearSessions();
  await createAdminSession(database, TOKEN_FINGERPRINT, OPENED_AT);
  await createAdminSession(database, TOKEN_FINGERPRINT, later(SESSION_DURATION_MS + 1));
  const [rows] = await database.execute('SELECT COUNT(*) AS total FROM admin_sessions');
  assert.equal(Number(rows[0].total), 1);
});

databaseTest('ignore un identifiant de session vide', async () => {
  assert.equal(await findAdminSessionExpiration(database, '', TOKEN_FINGERPRINT, OPENED_AT), null);
  await deleteAdminSession(database, '');
});
