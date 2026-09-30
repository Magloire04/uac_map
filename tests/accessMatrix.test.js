/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Matrice de droits : chaque route, pour chaque type d'appelant. Seul le code HTTP compte ici. Les corps envoyés
// sont vides ou désignent un élément inexistant : aucune route ne modifie vraiment la carte.

import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { rewriteCampusMap, setPerimeter } from '../server/database/campusMapRepository.js';
import { createContributionLink } from '../server/database/contributionLinkRepository.js';
import { createReviewer } from '../server/database/reviewerRepository.js';
import { createSquarePerimeter } from './helpers.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
const ROUTES = [
  ['GET', '/contribution/public-link', 'public'],
  ['POST', '/contributors', 'public'],
  ['GET', '/contributors/me', 'contributor'],
  ['PATCH', '/contributors/me', 'contributor'],
  ['GET', '/contributors/me/proposals', 'contributor'],
  ['POST', '/proposals', 'contributor'],
  ['GET', '/proposals', 'staff'],
  ['GET', '/proposals/inexistant', 'staff'],
  ['PATCH', '/proposals/inexistant', 'staff'],
  ['GET', '/contributors', 'staff'],
  ['PATCH', '/contributors/inexistant', 'staff'],
  ['GET', '/map-changes', 'staff'],
  ['POST', '/map-changes', 'staff'],
  ['POST', '/places', 'staff'],
  ['PUT', '/places/inexistant', 'staff'],
  ['DELETE', '/places/inexistant', 'staff'],
  ['POST', '/paths', 'staff'],
  ['PATCH', '/paths/inexistant', 'staff'],
  ['DELETE', '/paths/inexistant', 'staff'],
  ['GET', '/reviewers', 'administrator'],
  ['POST', '/reviewers', 'administrator'],
  ['DELETE', '/reviewers/inexistant', 'administrator'],
  ['GET', '/contribution-links', 'administrator'],
  ['POST', '/contribution-links', 'administrator'],
  ['PATCH', '/contribution-links/inexistant', 'administrator'],
  ['PATCH', '/campus-settings', 'administrator'],
  ['DELETE', '/campus-map', 'administrator'],
];
const isAllowed = (status) => status !== 401 && status !== 403;
const isUnauthorized = (status) => status === 401;
const EXPECTED = {
  public: { anonymous: isAllowed, contributor: isAllowed, reviewer: isAllowed, admin: isAllowed },
  contributor: { anonymous: isUnauthorized, contributor: isAllowed, reviewer: isUnauthorized, admin: isUnauthorized },
  staff: { anonymous: isUnauthorized, contributor: isUnauthorized, reviewer: isAllowed, admin: isAllowed },
  administrator: {
    anonymous: isUnauthorized,
    contributor: isUnauthorized,
    reviewer: (status) => status === 403,
    admin: isAllowed,
  },
};
let server;
let baseUrl;
let database;
const cookies = {};

function callApi(path, { method = 'GET', body, cookie } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const readCookieHeader = (response) => response.headers.get('set-cookie').split(';')[0];

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  await setPerimeter(database, createSquarePerimeter(500));
  const link = await createContributionLink(database, { label: 'Matrice', isPublic: true });
  server = createApp({ database, adminToken: ADMIN_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { token } = await createReviewer(database, 'Relecteur de la matrice');
  cookies.reviewer = readCookieHeader(await callApi('/admin/session', { method: 'POST', body: { token } }));
  cookies.admin = readCookieHeader(await callApi('/admin/session', { method: 'POST', body: { token: ADMIN_TOKEN } }));
  cookies.contributor = readCookieHeader(
    await callApi('/contributors', { method: 'POST', body: { linkCode: link.id } }),
  );
});

databaseAfter(async () => {
  server.close();
  await database.end();
});

databaseTest('vérifie la matrice de droits sur chaque route', async () => {
  for (const [method, path, access] of ROUTES) {
    for (const caller of ['anonymous', 'contributor', 'reviewer', 'admin']) {
      const response = await callApi(path, {
        method,
        cookie: cookies[caller],
        body: method === 'GET' ? undefined : {},
      });
      assert.ok(EXPECTED[access][caller](response.status), `${method} ${path} (${caller}) : ${response.status}`);
    }
  }
});
