/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { rewriteCampusMap, setPerimeter } from '../server/database/campusMapRepository.js';
import { createSquarePerimeter, offsetPosition } from './helpers.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
let server;
let baseUrl;
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  await setPerimeter(database, createSquarePerimeter(500));
  server = createApp({ database, adminToken: ADMIN_TOKEN, publicUrl: 'https://carte.example' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

databaseAfter(async () => {
  server.close();
  await database.end();
});

function callApi(path, { method = 'GET', body, cookie, bearerToken, headers = {} } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const adminCall = (path, options = {}) => callApi(path, { ...options, bearerToken: ADMIN_TOKEN });
const readData = async (response) => (await response.json()).data;

databaseTest('crée un relecteur dont le jeton n’est montré qu’une fois, puis le révoque', async () => {
  const created = await adminCall('/reviewers', { method: 'POST', body: { name: '  Aïcha  ' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const reviewer = await readData(created);
  assert.equal(reviewer.name, 'Aïcha');
  assert.ok(reviewer.token.length >= 40);
  const listed = (await readData(await adminCall('/reviewers'))).find((candidate) => candidate.id === reviewer.id);
  assert.deepEqual([listed.isActive, 'token' in listed], [true, false]);
  const login = await callApi('/admin/session', { method: 'POST', body: { token: reviewer.token } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await callApi('/admin/session', { cookie })).status, 200);
  assert.equal((await adminCall(`/reviewers/${reviewer.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await callApi('/admin/session', { cookie })).status, 401);
  assert.equal((await adminCall(`/reviewers/${reviewer.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await adminCall('/reviewers/inconnu', { method: 'DELETE' })).status, 404);
});

databaseTest('refuse un nom de relecteur vide ou trop long', async () => {
  for (const name of ['', '   ', 'x'.repeat(81), 42]) {
    const response = await adminCall('/reviewers', { method: 'POST', body: { name } });
    assert.equal(response.status, 400, String(name).slice(0, 10));
  }
});

databaseTest('gère les liens : un seul public, fermeture, réouverture', async () => {
  const create = async (body) => readData(await adminCall('/contribution-links', { method: 'POST', body }));
  const first = await create({ label: 'Lien public du site', isPublic: true });
  assert.equal(first.url, `https://carte.example/?contribuer=${first.id}`);
  assert.equal((await readData(await callApi('/contribution/public-link'))).code, first.id);
  const second = await create({ label: 'Nouveau lien public', isPublic: true });
  assert.equal((await readData(await callApi('/contribution/public-link'))).code, second.id);
  const closed = await readData(
    await adminCall(`/contribution-links/${second.id}`, { method: 'PATCH', body: { isActive: false } }),
  );
  assert.deepEqual([closed.isActive, closed.isPublic], [false, false]);
  assert.equal((await callApi('/contribution/public-link')).status, 404);
  assert.equal((await callApi('/contributors', { method: 'POST', body: { linkCode: second.id } })).status, 410);
  const closedAndPublic = await adminCall(`/contribution-links/${second.id}`, {
    method: 'PATCH',
    body: { isPublic: true },
  });
  assert.equal(closedAndPublic.status, 400);
  await adminCall(`/contribution-links/${first.id}`, {
    method: 'PATCH',
    body: { isPublic: true, label: 'Lien du site' },
  });
  const links = await (await adminCall('/contribution-links')).json();
  assert.equal(links.meta.total, 2);
  assert.equal(links.data.find((link) => link.id === first.id).label, 'Lien du site');
  const unknown = await adminCall('/contribution-links/inconnu', { method: 'PATCH', body: { isActive: false } });
  assert.equal(unknown.status, 404);
  const invalid = await adminCall(`/contribution-links/${first.id}`, { method: 'PATCH', body: { isPublic: 'oui' } });
  assert.equal(invalid.status, 400);
  const tooLong = await adminCall('/contribution-links', { method: 'POST', body: { label: 'x'.repeat(81) } });
  assert.equal(tooLong.status, 400);
});

databaseTest('suspend les contributions sans gêner l’administrateur', async () => {
  const link = await readData(await adminCall('/contribution-links', { method: 'POST', body: { label: 'Pause' } }));
  const headers = { 'X-Forwarded-For': '198.51.100.7' };
  const joined = await callApi('/contributors', { method: 'POST', body: { linkCode: link.id }, headers });
  const cookie = joined.headers.get('set-cookie').split(';')[0];
  const paused = await adminCall('/campus-settings', { method: 'PATCH', body: { contributionsPaused: true } });
  assert.equal((await readData(paused)).contributionsPaused, true);
  assert.equal((await readData(await callApi('/campus-map'))).settings.contributionsPaused, true);
  const [longitude, latitude] = offsetPosition(10, 10);
  const proposal = await callApi('/proposals', {
    method: 'POST',
    cookie,
    headers,
    body: {
      entityType: 'place',
      action: 'create',
      payload: { name: 'Pendant la pause', longitude, latitude },
      devicePosition: { longitude, latitude, accuracy: 5, ageMs: 500 },
    },
  });
  assert.deepEqual([proposal.status, (await proposal.json()).error.code], [503, 'CONTRIBUTIONS_PAUSED']);
  const adminWrite = await adminCall('/places', {
    method: 'POST',
    body: { name: 'Pendant la pause', longitude, latitude },
  });
  assert.equal(adminWrite.status, 201);
  await adminCall('/campus-settings', { method: 'PATCH', body: { contributionsPaused: false } });
  assert.equal((await adminCall('/campus-settings', { method: 'PATCH', body: {} })).status, 400);
});
