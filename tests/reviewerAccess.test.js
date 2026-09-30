/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { rewriteCampusMap } from '../server/database/campusMapRepository.js';
import { listMapChanges } from '../server/database/mapChangeRepository.js';
import { createReviewer, revokeReviewer } from '../server/database/reviewerRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
const validPlace = { name: 'Amphi Test', category: 'lecture-hall', longitude: 2.342, latitude: 6.416, entrances: [] };
let server;
let baseUrl;
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  server = createApp({ database, adminToken: ADMIN_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

databaseAfter(async () => {
  server.close();
  await database.end();
});

function callApi(path, { method = 'GET', body, cookie, bearerToken } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function openSession(token) {
  const response = await callApi('/admin/session', { method: 'POST', body: { token } });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

databaseTest('ouvre une session de relecteur avec son jeton personnel', async () => {
  const { token } = await createReviewer(database, 'Aïcha');
  const { response, cookie } = await openSession(token);
  assert.equal(response.status, 201);
  const opened = (await response.json()).data;
  assert.deepEqual([opened.role, opened.name], ['reviewer', 'Aïcha']);
  const current = (await (await callApi('/admin/session', { cookie })).json()).data;
  assert.deepEqual([current.role, current.name], ['reviewer', 'Aïcha']);
  const admin = await openSession(ADMIN_TOKEN);
  assert.equal((await admin.response.json()).data.role, 'admin');
  const bearer = await callApi('/places', { method: 'POST', body: validPlace, bearerToken: token });
  assert.equal(bearer.status, 401);
});

databaseTest('les écritures d’un relecteur entrent dans l’historique à son nom', async () => {
  const { reviewer, token } = await createReviewer(database, 'Koffi');
  const { cookie } = await openSession(token);
  const created = await callApi('/places', { method: 'POST', body: validPlace, cookie });
  assert.equal(created.status, 201);
  const placeId = (await created.json()).data.id;
  const [change] = (await listMapChanges(database, { page: 1, limit: 20, entityId: placeId })).items;
  assert.deepEqual([change.actorKind, change.actorId, change.actorName], ['reviewer', reviewer.id, 'Koffi']);
});

databaseTest('un relecteur ne peut pas vider la carte, l’administrateur le peut', async () => {
  const { token } = await createReviewer(database, 'Relecteur prudent');
  const reviewerSession = await openSession(token);
  const refused = await callApi('/campus-map?confirm=true', { method: 'DELETE', cookie: reviewerSession.cookie });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, 'FORBIDDEN');
  const adminSession = await openSession(ADMIN_TOKEN);
  const cleared = await callApi('/campus-map?confirm=true', { method: 'DELETE', cookie: adminSession.cookie });
  assert.equal(cleared.status, 204);
});

databaseTest('révoquer un relecteur ferme sa session et refuse son jeton', async () => {
  const { reviewer, token } = await createReviewer(database, 'Partant');
  const { cookie } = await openSession(token);
  await revokeReviewer(database, reviewer.id);
  assert.equal((await callApi('/admin/session', { cookie })).status, 401);
  assert.equal((await callApi('/places', { method: 'POST', body: validPlace, cookie })).status, 401);
  const { response } = await openSession(token);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'INVALID_TOKEN');
});
