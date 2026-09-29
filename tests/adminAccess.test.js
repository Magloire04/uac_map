/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createClientDigest } from '../server/adminSessions.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
const servers = [];
const pools = [];
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  for (const server of servers) server.close();
  await Promise.all([...pools, database].map((pool) => pool.end()));
});

// Chaque instance a son propre pool, comme deux copies de l'application sur l'hébergement.
async function startApp(options = {}) {
  const instancePool = createTestPool();
  pools.push(instancePool);
  const server = createApp({ database: instancePool, adminToken: ADMIN_TOKEN, ...options }).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const login = (baseUrl, { token = ADMIN_TOKEN, headers = {} } = {}) =>
  fetch(`${baseUrl}/api/v1/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ token }),
  });

async function failTenTimes(baseUrl, headers) {
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await login(baseUrl, { token: 'mauvais-jeton-000', headers })).status, 401);
  }
}

const clearAttempts = () => database.execute('DELETE FROM failed_login_attempts');

databaseTest('partage le blocage entre deux instances de l’application', async () => {
  await clearAttempts();
  const firstInstance = await startApp();
  const secondInstance = await startApp();
  const headers = { 'X-Forwarded-For': '203.0.113.7' };
  await failTenTimes(firstInstance, headers);
  assert.equal((await login(secondInstance, { headers })).status, 429);
});

databaseTest('distingue les clients derrière le proxy local quand TRUST_PROXY vaut loopback', async () => {
  await clearAttempts();
  const baseUrl = await startApp({ trustProxy: 'loopback' });
  await failTenTimes(baseUrl, { 'X-Forwarded-For': '203.0.113.10' });
  assert.equal((await login(baseUrl, { headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 429);
  assert.equal((await login(baseUrl, { headers: { 'X-Forwarded-For': '203.0.113.11' } })).status, 201);
});

databaseTest('ignore X-Forwarded-For quand TRUST_PROXY vaut false', async () => {
  await clearAttempts();
  const baseUrl = await startApp({ trustProxy: false });
  await failTenTimes(baseUrl, { 'X-Forwarded-For': '203.0.113.20' });
  assert.equal((await login(baseUrl, { headers: { 'X-Forwarded-For': '203.0.113.21' } })).status, 429);
  await clearAttempts();
});

databaseTest('ajoute Secure au cookie quand un proxy de confiance signale HTTPS', async () => {
  const trusting = await startApp({ trustProxy: 'loopback' });
  const distrusting = await startApp({ trustProxy: false });
  const headers = { 'X-Forwarded-Proto': 'https' };
  assert.match((await login(trusting, { headers })).headers.get('set-cookie'), /; Secure/);
  assert.doesNotMatch((await login(distrusting, { headers })).headers.get('set-cookie'), /Secure/);
});

databaseTest('ne stocke que l’empreinte de l’adresse du client', async () => {
  await clearAttempts();
  const baseUrl = await startApp();
  await login(baseUrl, { token: 'mauvais-jeton-000', headers: { 'X-Forwarded-For': '203.0.113.30' } });
  const [rows] = await database.execute('SELECT client_digest FROM failed_login_attempts');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].client_digest, createClientDigest('203.0.113.30', ADMIN_TOKEN));
  assert.ok(!rows[0].client_digest.includes(Buffer.from('203.0.113.30')));
});

databaseTest('ferme les sessions ouvertes quand ADMIN_TOKEN change', async () => {
  const beforeRotation = await startApp();
  const afterRotation = await startApp({ adminToken: 'nouveau-jeton-de-test-5678' });
  const cookie = (await login(beforeRotation)).headers.get('set-cookie').split(';')[0];
  const checkSession = (baseUrl) => fetch(`${baseUrl}/api/v1/admin/session`, { headers: { Cookie: cookie } });
  assert.equal((await checkSession(beforeRotation)).status, 200);
  assert.equal((await checkSession(afterRotation)).status, 401);
});

databaseTest('répond 401 à un cookie de session fantaisiste', async () => {
  const baseUrl = await startApp();
  for (const value of ['', 'x', 'x'.repeat(5000), '%E0%A4%A']) {
    const response = await fetch(`${baseUrl}/api/v1/admin/session`, {
      headers: { Cookie: `uac_admin_session=${value}` },
    });
    assert.equal(response.status, 401, value.slice(0, 12));
  }
});

databaseTest('ne laisse comparer que dix jetons quand les essais arrivent en parallèle', async () => {
  await clearAttempts();
  const baseUrl = await startApp();
  const headers = { 'X-Forwarded-For': '203.0.113.40' };
  const statuses = await Promise.all(
    Array.from({ length: 30 }, async () => (await login(baseUrl, { token: 'mauvais-jeton-000', headers })).status),
  );
  assert.ok(statuses.filter((status) => status === 401).length <= 10, `401 reçus : ${statuses.join(',')}`);
  assert.equal(
    statuses.filter((status) => status === 429).length,
    30 - statuses.filter((status) => status === 401).length,
  );
  await clearAttempts();
});
