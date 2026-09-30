/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import {
  insertPlace,
  readCampusMap,
  rewriteCampusMap,
  setContributionsPaused,
  setPerimeter,
} from '../server/database/campusMapRepository.js';
import { createContributionLink, updateContributionLink } from '../server/database/contributionLinkRepository.js';
import { setContributorStatus } from '../server/database/contributorRepository.js';
import { listMapChanges } from '../server/database/mapChangeRepository.js';
import { createSquarePerimeter, offsetPosition } from './helpers.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
const PERIMETER = createSquarePerimeter(500);
let server;
let baseUrl;
let database;
let publicLink;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  await setPerimeter(database, PERIMETER);
  publicLink = await createContributionLink(database, { label: 'Lien public du site', isPublic: true });
  server = createApp({ database, adminToken: ADMIN_TOKEN, publicUrl: 'https://carte.example' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

databaseAfter(async () => {
  server.close();
  await database.end();
});

function callApi(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Chaque téléphone de test a sa propre adresse (X-Forwarded-For, lu derrière le proxy local) : les limites par
// connexion des uns ne gênent pas les autres.
let phoneCount = 0;
async function joinAsPhone(pseudonym) {
  phoneCount += 1;
  const headers = { 'X-Forwarded-For': `198.51.100.${phoneCount}` };
  const response = await callApi('/contributors', {
    method: 'POST',
    body: { linkCode: publicLink.id, pseudonym },
    headers,
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const contributor = (await response.json()).data;
  const call = (path, options = {}) => callApi(path, { ...options, cookie, headers });
  return { contributor, call };
}

const onCampus = (overrides = {}) => {
  const [longitude, latitude] = offsetPosition(10, 10);
  return { longitude, latitude, accuracy: 8, ageMs: 2000, ...overrides };
};

const placeProposal = (name = 'Kiosque de la FASEG') => {
  const [longitude, latitude] = offsetPosition(40, -25);
  return {
    entityType: 'place',
    action: 'create',
    payload: { name, category: 'food', longitude, latitude, entrances: [] },
    devicePosition: onCampus(),
  };
};

const readErrorCode = async (response) => (await response.json()).error.code;

databaseTest('donne le lien public avec son adresse complète', async () => {
  const response = await callApi('/contribution/public-link');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    code: publicLink.id,
    url: `https://carte.example/?contribuer=${publicLink.id}`,
  });
});

databaseTest('sert le QR code du lien public en SVG', async () => {
  const response = await callApi('/contribution/public-link/qr-code');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await response.text(), /<svg/);
});

databaseTest('rejoint par le lien avec un cookie sûr, et reconnaît un téléphone déjà inscrit', async () => {
  const response = await callApi('/contributors', {
    method: 'POST',
    body: { linkCode: publicLink.id, pseudonym: '  Awa ' },
    headers: { 'X-Forwarded-For': '198.51.100.250' },
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^uac_contributor=[A-Za-z0-9_-]{43};/);
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/api', 'Max-Age=15552000']) {
    assert.ok(setCookie.includes(attribute), attribute);
  }
  const contributor = (await response.json()).data;
  assert.deepEqual([contributor.pseudonym, contributor.status], ['Awa', 'new']);
  const cookie = setCookie.split(';')[0];
  const again = await callApi('/contributors', { method: 'POST', body: { linkCode: publicLink.id }, cookie });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).data.id, contributor.id);
});

databaseTest('refuse un lien inconnu, mal formé ou fermé', async () => {
  for (const linkCode of ['inconnu', ['tableau'], 42, undefined]) {
    const response = await callApi('/contributors', { method: 'POST', body: { linkCode } });
    assert.equal(response.status, 404, String(linkCode));
    assert.equal(await readErrorCode(response), 'LINK_NOT_FOUND');
  }
  const closedLink = await createContributionLink(database, { label: 'Promo fermée' });
  await updateContributionLink(database, closedLink.id, { isActive: false });
  const response = await callApi('/contributors', { method: 'POST', body: { linkCode: closedLink.id } });
  assert.equal(response.status, 410);
  assert.equal(await readErrorCode(response), 'LINK_CLOSED');
});

databaseTest('ignore un cookie contributeur fantaisiste', async () => {
  for (const cookie of ['uac_contributor=', 'uac_contributor=%E0%A4%A', `uac_contributor=${'x'.repeat(4000)}`]) {
    const response = await callApi('/contributors/me', { cookie });
    assert.equal(response.status, 401, cookie.slice(0, 30));
    assert.equal(await readErrorCode(response), 'NOT_A_CONTRIBUTOR');
  }
});

databaseTest('montre, renomme puis oublie un téléphone', async () => {
  const phone = await joinAsPhone('Koffi');
  assert.equal((await (await phone.call('/contributors/me')).json()).data.pseudonym, 'Koffi');
  const renamed = await phone.call('/contributors/me', { method: 'PATCH', body: { pseudonym: 'K.' } });
  assert.equal((await renamed.json()).data.pseudonym, 'K.');
  const tooLong = await phone.call('/contributors/me', { method: 'PATCH', body: { pseudonym: 'x'.repeat(41) } });
  assert.equal(tooLong.status, 400);
  const pending = await phone.call('/proposals', { method: 'POST', body: placeProposal('Proposition à retirer') });
  const proposalId = (await pending.json()).data.id;
  const forgotten = await phone.call('/contributors/me', { method: 'DELETE' });
  assert.equal(forgotten.status, 204);
  assert.match(forgotten.headers.get('set-cookie'), /^uac_contributor=;.*Max-Age=0/);
  assert.equal((await phone.call('/contributors/me')).status, 401);
  const [rows] = await database.execute('SELECT `status`, contributor_id FROM proposals WHERE id = ?', [proposalId]);
  assert.deepEqual([rows[0].status, rows[0].contributor_id], ['withdrawn', null]);
});

databaseTest('renouvelle le cookie du contributeur à chaque visite et à chaque nouvelle inscription', async () => {
  const joined = await callApi('/contributors', { method: 'POST', body: { linkCode: publicLink.id } });
  const sentCookie = joined.headers.get('set-cookie').split(';')[0];
  const visit = await callApi('/contributors/me', { cookie: sentCookie });
  const renewed = visit.headers.get('set-cookie');
  assert.equal(renewed.split(';')[0], sentCookie);
  assert.ok(renewed.includes('Max-Age=15552000'));
  const again = await callApi('/contributors', {
    method: 'POST',
    body: { linkCode: publicLink.id },
    cookie: sentCookie,
  });
  assert.equal(again.status, 200);
  const againCookie = again.headers.get('set-cookie');
  assert.equal(againCookie.split(';')[0], sentCookie);
  assert.ok(againCookie.includes('Max-Age=15552000'));
});

databaseTest('modifier un téléphone sans préciser de pseudo garde le pseudo', async () => {
  const phone = await joinAsPhone('Kossi');
  const kept = await phone.call('/contributors/me', { method: 'PATCH', body: {} });
  assert.equal(kept.status, 200);
  assert.equal((await kept.json()).data.pseudonym, 'Kossi');
  const cleared = await phone.call('/contributors/me', { method: 'PATCH', body: { pseudonym: '' } });
  assert.equal((await cleared.json()).data.pseudonym, null);
});

databaseTest(
  'un nouveau contributeur propose un lieu, qui attend une relecture hors de la carte publique',
  async () => {
    const phone = await joinAsPhone();
    const response = await phone.call('/proposals', { method: 'POST', body: placeProposal('Kiosque en attente') });
    assert.equal(response.status, 201);
    const proposal = (await response.json()).data;
    assert.deepEqual([proposal.status, proposal.payload.name], ['pending', 'Kiosque en attente']);
    assert.equal('positionAccuracyMeters' in proposal, false);
    const campusMap = (await (await callApi('/campus-map')).json()).data;
    assert.equal(
      campusMap.places.some((place) => place.name === 'Kiosque en attente'),
      false,
    );
    const mine = await (await phone.call('/contributors/me/proposals')).json();
    assert.deepEqual(mine.meta, { page: 1, limit: 20, total: 1 });
    assert.equal(mine.data[0].id, proposal.id);
    const [rows] = await database.execute('SELECT position_accuracy_meters FROM proposals WHERE id = ?', [proposal.id]);
    assert.equal(rows[0].position_accuracy_meters, 8);
  },
);

databaseTest('un contributeur de confiance publie directement, et la publication entre dans l’historique', async () => {
  const phone = await joinAsPhone('Confiance');
  await setContributorStatus(database, phone.contributor.id, 'trusted');
  const response = await phone.call('/proposals', { method: 'POST', body: placeProposal('Kiosque publié') });
  const proposal = (await response.json()).data;
  assert.equal(proposal.status, 'accepted');
  const place = (await readCampusMap(database)).places.find((candidate) => candidate.name === 'Kiosque publié');
  assert.ok(place);
  const [change] = (await listMapChanges(database, { page: 1, limit: 20, entityId: place.id })).items;
  assert.deepEqual(
    [change.action, change.actorKind, change.actorId, change.proposalId],
    ['create', 'contributor', phone.contributor.id, proposal.id],
  );
  const report = await phone.call('/proposals', {
    method: 'POST',
    body: {
      entityType: 'place',
      action: 'report',
      targetId: place.id,
      payload: { message: 'Fermé le samedi' },
      devicePosition: onCampus(),
    },
  });
  assert.equal((await report.json()).data.status, 'pending');
});

databaseTest('propose une correction et un chemin, et vérifie que la cible existe', async () => {
  const phone = await joinAsPhone();
  const [longitude, latitude] = offsetPosition(-30, 60);
  const target = {
    id: 'place_cible',
    name: 'Rectorat',
    category: 'administration',
    aliases: [],
    description: '',
    access: '',
    longitude,
    latitude,
    entrances: [],
  };
  await insertPlace(database, target);
  const update = await phone.call('/proposals', {
    method: 'POST',
    body: {
      entityType: 'place',
      action: 'update',
      targetId: target.id,
      payload: { ...target, name: 'Rectorat UAC' },
      devicePosition: onCampus(),
    },
  });
  assert.equal(update.status, 201);
  const [rows] = await database.execute('SELECT target_updated_at FROM proposals WHERE id = ?', [
    (await update.json()).data.id,
  ]);
  assert.ok(rows[0].target_updated_at instanceof Date);
  const missing = await phone.call('/proposals', {
    method: 'POST',
    body: {
      entityType: 'place',
      action: 'report',
      targetId: 'place_inconnu',
      payload: { message: 'Introuvable' },
      devicePosition: onCampus(),
    },
  });
  assert.equal(missing.status, 404);
  assert.equal(await readErrorCode(missing), 'TARGET_NOT_FOUND');
  const path = await phone.call('/proposals', {
    method: 'POST',
    body: {
      entityType: 'path',
      action: 'create',
      payload: { type: 'footpath', coordinates: [offsetPosition(0, 0), offsetPosition(50, 10)] },
      devicePosition: onCampus(),
    },
  });
  assert.equal(path.status, 201);
});

databaseTest('refuse une proposition dont la présence sur le campus n’est pas vérifiée', async () => {
  const phone = await joinAsPhone();
  const [farLongitude, farLatitude] = offsetPosition(5000, 0);
  const cases = [
    [undefined, 'POSITION_REQUIRED'],
    [{ longitude: '2.34', latitude: '6.41', accuracy: '5', ageMs: '10' }, 'POSITION_REQUIRED'],
    [[], 'POSITION_REQUIRED'],
    [onCampus({ longitude: farLongitude, latitude: farLatitude }), 'OUTSIDE_CAMPUS'],
    [onCampus({ accuracy: 80 }), 'POSITION_INACCURATE'],
    [onCampus({ ageMs: 5 * 60 * 1000 }), 'POSITION_TOO_OLD'],
  ];
  for (const [devicePosition, code] of cases) {
    const response = await phone.call('/proposals', { method: 'POST', body: { ...placeProposal(), devicePosition } });
    assert.equal(response.status, 422, code);
    assert.equal(await readErrorCode(response), code);
  }
  const farPlace = placeProposal('Lieu lointain');
  farPlace.payload.longitude = farLongitude;
  farPlace.payload.latitude = farLatitude;
  const geometry = await phone.call('/proposals', { method: 'POST', body: farPlace });
  assert.equal(geometry.status, 422);
  assert.equal(await readErrorCode(geometry), 'GEOMETRY_OUTSIDE_CAMPUS');
});

databaseTest('refuse les envois pendant une suspension, sans périmètre, ou d’un téléphone bloqué', async () => {
  const phone = await joinAsPhone();
  await setContributionsPaused(database, true);
  const paused = await phone.call('/proposals', { method: 'POST', body: placeProposal() });
  assert.deepEqual([paused.status, await readErrorCode(paused)], [503, 'CONTRIBUTIONS_PAUSED']);
  await setContributionsPaused(database, false);
  await setPerimeter(database, null);
  const noPerimeter = await phone.call('/proposals', { method: 'POST', body: placeProposal() });
  assert.deepEqual([noPerimeter.status, await readErrorCode(noPerimeter)], [503, 'PERIMETER_NOT_CONFIGURED']);
  await setPerimeter(database, PERIMETER);
  await setContributorStatus(database, phone.contributor.id, 'blocked');
  const blocked = await phone.call('/proposals', { method: 'POST', body: placeProposal() });
  assert.deepEqual([blocked.status, await readErrorCode(blocked)], [403, 'CONTRIBUTOR_BLOCKED']);
});

databaseTest('limite les envois à 30 par heure et par téléphone, envois refusés compris', async () => {
  const phone = await joinAsPhone();
  await database.execute('DELETE FROM rate_limits');
  const invalid = { entityType: 'place', action: 'create', payload: {}, devicePosition: onCampus() };
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await phone.call('/proposals', { method: 'POST', body: invalid })).status, 400);
  }
  const response = await phone.call('/proposals', { method: 'POST', body: placeProposal() });
  assert.deepEqual([response.status, await readErrorCode(response)], [429, 'TOO_MANY_REQUESTS']);
});

databaseTest('refuse plus de 100 inscriptions par heure depuis une même connexion', async () => {
  await database.execute('DELETE FROM rate_limits');
  const headers = { 'X-Forwarded-For': '203.0.113.99' };
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await callApi('/contributors', { method: 'POST', body: { linkCode: publicLink.id }, headers });
    assert.equal(response.status, 201);
  }
  const refused = await callApi('/contributors', { method: 'POST', body: { linkCode: publicLink.id }, headers });
  assert.deepEqual([refused.status, await readErrorCode(refused)], [429, 'TOO_MANY_REQUESTS']);
});
