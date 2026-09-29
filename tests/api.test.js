/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampusMapStore } from '../server/store.js';
import { createApp } from '../server/app.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
let server;
let baseUrl;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'uac-map-'));
  const store = new CampusMapStore(join(temporaryDirectory, 'campus.json'));
  await store.load();
  server = createApp({ store, adminToken: ADMIN_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function callApi(path, { method = 'GET', body, bearerToken, cookie } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const adminCall = (path, options = {}) => callApi(path, { ...options, bearerToken: ADMIN_TOKEN });
const validPlace = { name: 'Amphi Test', category: 'lecture-hall', longitude: 2.342, latitude: 6.416, entrances: [] };

test('renvoie la carte complète dans une enveloppe data', async () => {
  const response = await callApi('/campus-map');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.places, []);
});

test('ajoute les en-têtes de sécurité et un X-Request-ID', async () => {
  const response = await callApi('/health');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.ok(response.headers.get('x-request-id'));
});

test('reprend le X-Request-ID fourni par le client', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`, { headers: { 'X-Request-ID': 'trace-12345678' } });
  assert.equal(response.headers.get('x-request-id'), 'trace-12345678');
});

test('refuse une écriture sans authentification avec une erreur 401 normalisée', async () => {
  const response = await callApi('/places', { method: 'POST', body: validPlace });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: 'UNAUTHORIZED', message: 'Session du mode collecte absente ou expirée', status: 401 },
  });
});

test('refuse la connexion avec un jeton incorrect', async () => {
  const response = await callApi('/admin/session', { method: 'POST', body: { token: 'mauvais-jeton' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'INVALID_TOKEN');
});

test('ouvre une session dans un cookie httpOnly qui autorise les écritures', async () => {
  const login = await callApi('/admin/session', { method: 'POST', body: { token: ADMIN_TOKEN } });
  assert.equal(login.status, 201);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const created = await callApi('/places', { method: 'POST', body: validPlace, cookie });
  assert.equal(created.status, 201);
  await adminCall(`/places/${(await created.json()).data.id}`, { method: 'DELETE' });
});

test('ferme la session à la déconnexion', async () => {
  const login = await callApi('/admin/session', { method: 'POST', body: { token: ADMIN_TOKEN } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await callApi('/admin/session', { method: 'DELETE', cookie })).status, 204);
  assert.equal((await callApi('/admin/session', { cookie })).status, 401);
});

test('crée, remplace puis supprime un lieu', async () => {
  const created = await adminCall('/places', {
    method: 'POST',
    body: { ...validPlace, entrances: [{ longitude: 2.3421, latitude: 6.416, note: 'Porte nord' }] },
  });
  assert.equal(created.status, 201);
  const place = (await created.json()).data;
  const replaced = await adminCall(`/places/${place.id}`, { method: 'PUT', body: { ...place, name: 'Amphi Test 2' } });
  assert.equal((await replaced.json()).data.name, 'Amphi Test 2');
  assert.equal((await adminCall(`/places/${place.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await callApi(`/places/${place.id}`)).status, 404);
});

test('met à jour partiellement un chemin sans toucher au tracé', async () => {
  const created = await adminCall('/paths', {
    method: 'POST',
    body: {
      type: 'stairs',
      coordinates: [
        [2.342, 6.416],
        [2.3425, 6.4162],
      ],
    },
  });
  const path = (await created.json()).data;
  const updated = await adminCall(`/paths/${path.id}`, { method: 'PATCH', body: { isFloodProne: true } });
  const { data } = await updated.json();
  assert.equal(data.isFloodProne, true);
  assert.equal(data.type, 'stairs');
  assert.deepEqual(data.coordinates, path.coordinates);
  await adminCall(`/paths/${path.id}`, { method: 'DELETE' });
});

test('pagine la liste des lieux avec meta', async () => {
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await adminCall('/places', { method: 'POST', body: { ...validPlace, name } });
  }
  const response = await callApi('/places?page=2&limit=2');
  const payload = await response.json();
  assert.deepEqual(payload.meta, { page: 2, limit: 2, total: 3 });
  assert.deepEqual(
    payload.data.map((place) => place.name),
    ['Charlie'],
  );
  await adminCall('/campus-map?confirm=true', { method: 'DELETE' });
});

test('refuse une limite de pagination supérieure à 100', async () => {
  const response = await callApi('/places?limit=500');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_LIMIT');
});

test('renvoie un QR code SVG pour un lieu existant', async () => {
  const place = (await (await adminCall('/places', { method: 'POST', body: validPlace })).json()).data;
  const response = await callApi(`/places/${place.id}/qr-code`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<svg/);
  await adminCall(`/places/${place.id}`, { method: 'DELETE' });
});

test('exporte la carte au format GeoJSON', async () => {
  const response = await callApi('/campus-map?format=geojson');
  assert.equal((await response.json()).type, 'FeatureCollection');
});

test('exige une confirmation explicite pour vider la carte', async () => {
  const response = await adminCall('/campus-map', { method: 'DELETE' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'CONFIRMATION_REQUIRED');
});

test('rejette une saisie invalide avec le code VALIDATION_ERROR', async () => {
  const response = await adminCall('/places', { method: 'POST', body: { ...validPlace, name: '' } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});

test('rejette un JSON mal formé', async () => {
  const response = await fetch(`${baseUrl}/api/v1/paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: '{pas du json',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_JSON');
});

test('renvoie 404 ROUTE_NOT_FOUND sur une route inconnue', async () => {
  const response = await callApi('/inconnue');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'ROUTE_NOT_FOUND');
});

test('sert le code partagé et la bibliothèque de carte', async () => {
  for (const path of ['/shared/graph.js', '/vendor/maplibre/maplibre-gl.mjs']) {
    assert.equal((await fetch(baseUrl + path)).status, 200, path);
  }
});

test('chaque route du contrat OpenAPI existe dans le serveur', async () => {
  const { readFile } = await import('node:fs/promises');
  const contract = await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const operations = [];
  let currentPath = null;
  let isInPaths = false;
  for (const line of contract.split('\n')) {
    if (line === 'paths:') isInPaths = true;
    if (!isInPaths) continue;
    const pathMatch = line.match(/^ {2}(\/\S+):$/);
    if (pathMatch) currentPath = pathMatch[1];
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete):$/);
    if (methodMatch && currentPath) operations.push([methodMatch[1].toUpperCase(), currentPath]);
  }
  assert.ok(operations.length >= 15, `${operations.length} opérations lues`);
  for (const [method, path] of operations) {
    const concretePath = path.replace(/\{[^}]+\}/g, 'inexistant');
    const response = await adminCall(concretePath, { method, body: method === 'GET' ? undefined : {} });
    const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : {};
    assert.notEqual(payload.error?.code, 'ROUTE_NOT_FOUND', `${method} ${path}`);
  }
});
