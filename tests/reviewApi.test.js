/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { COMMAND_ACTOR } from '../server/actors.js';
import { createApp } from '../server/app.js';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import {
  findPlace,
  insertPlace,
  readCampusMap,
  rewriteCampusMap,
  setPerimeter,
} from '../server/database/campusMapRepository.js';
import { createContributionLink } from '../server/database/contributionLinkRepository.js';
import { recordMapChange } from '../server/database/mapChangeRepository.js';
import { createReviewer } from '../server/database/reviewerRepository.js';
import { createSquarePerimeter, offsetPosition } from './helpers.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const ADMIN_TOKEN = 'jeton-de-test-1234';
let server;
let baseUrl;
let database;
let publicLink;
let reviewerCookie;

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

async function openSession(token) {
  const response = await callApi('/admin/session', { method: 'POST', body: { token } });
  return response.headers.get('set-cookie').split(';')[0];
}

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  await setPerimeter(database, createSquarePerimeter(500));
  publicLink = await createContributionLink(database, { label: 'Lien public du site', isPublic: true });
  server = createApp({ database, adminToken: ADMIN_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  reviewerCookie = await openSession((await createReviewer(database, 'Aïcha')).token);
});

databaseAfter(async () => {
  server.close();
  await database.end();
});

const reviewerCall = (path, options = {}) => callApi(path, { ...options, cookie: reviewerCookie });
const adminCall = (path, options = {}) => callApi(path, { ...options, bearerToken: ADMIN_TOKEN });
const readData = async (response) => (await response.json()).data;
const onCampus = () => {
  const [longitude, latitude] = offsetPosition(5, 5);
  return { longitude, latitude, accuracy: 10, ageMs: 1000 };
};

let phoneCount = 0;
async function joinAsPhone() {
  phoneCount += 1;
  const headers = { 'X-Forwarded-For': `198.51.100.${phoneCount}` };
  const joined = await callApi('/contributors', { method: 'POST', body: { linkCode: publicLink.id }, headers });
  const cookie = joined.headers.get('set-cookie').split(';')[0];
  const contributor = await readData(joined);
  const call = (path, options = {}) => callApi(path, { ...options, cookie, headers });
  const propose = async (proposal) => {
    const sent = await call('/proposals', { method: 'POST', body: { ...proposal, devicePosition: onCampus() } });
    assert.equal(sent.status, 201);
    return readData(sent);
  };
  return { contributor, call, propose };
}

const newPlace = (name) => {
  const [longitude, latitude] = offsetPosition(40, -20);
  return { entityType: 'place', action: 'create', payload: { name, category: 'food', longitude, latitude } };
};

async function insertExistingPlace(id, name) {
  const [longitude, latitude] = offsetPosition(-60, 30);
  const place = {
    id,
    name,
    category: 'administration',
    aliases: [],
    description: '',
    access: '',
    longitude,
    latitude,
    entrances: [],
  };
  await insertPlace(database, place);
  return place;
}

const placesNamed = async (name) => (await readCampusMap(database)).places.filter((place) => place.name === name);
const accept = (proposalId, call = reviewerCall) =>
  call(`/proposals/${proposalId}`, { method: 'PATCH', body: { status: 'accepted' } });

databaseTest('liste la file de la plus ancienne à la plus récente, avec filtres', async () => {
  const phone = await joinAsPhone();
  const first = await phone.propose(newPlace('Première'));
  const second = await phone.propose({
    entityType: 'path',
    action: 'create',
    payload: { coordinates: [offsetPosition(0, 0), offsetPosition(30, 0)] },
  });
  const queue = await readData(await reviewerCall(`/proposals?status=pending&contributor-id=${phone.contributor.id}`));
  assert.deepEqual(
    queue.map((proposal) => proposal.id),
    [first.id, second.id],
  );
  assert.equal(queue[0].positionAccuracyMeters, 10);
  const paths = await readData(
    await reviewerCall(`/proposals?entity-type=path&contributor-id=${phone.contributor.id}`),
  );
  assert.deepEqual(
    paths.map((proposal) => proposal.id),
    [second.id],
  );
  assert.equal((await reviewerCall('/proposals?status=oubliee')).status, 400);
  assert.equal((await reviewerCall('/proposals?entity-type=campus')).status, 400);
});

databaseTest('accepter un nouveau lieu le publie, et le contributeur le voit publié', async () => {
  const phone = await joinAsPhone();
  const proposal = await phone.propose(newPlace('Kiosque accepté'));
  const detail = await readData(await reviewerCall(`/proposals/${proposal.id}`));
  assert.deepEqual([detail.hasConflict, detail.target, detail.contributor.pendingCount], [false, null, 1]);
  const accepted = await accept(proposal.id);
  assert.equal(accepted.status, 200);
  assert.equal((await readData(accepted)).reviewerKind, 'reviewer');
  const publicMap = await readData(await callApi('/campus-map'));
  const place = publicMap.places.find((candidate) => candidate.name === 'Kiosque accepté');
  assert.ok(place);
  const mine = await readData(await phone.call('/contributors/me/proposals'));
  assert.equal(mine[0].status, 'accepted');
  const [change] = await readData(await reviewerCall(`/map-changes?entity-id=${place.id}`));
  assert.deepEqual([change.action, change.actorName, change.proposalId], ['create', 'Aïcha', proposal.id]);
});

databaseTest('refuser montre la note au contributeur sans toucher à la carte', async () => {
  const phone = await joinAsPhone();
  const proposal = await phone.propose(newPlace('Doublon du Resto U'));
  const rejected = await reviewerCall(`/proposals/${proposal.id}`, {
    method: 'PATCH',
    body: { status: 'rejected', note: 'Déjà sur la carte' },
  });
  assert.equal((await readData(rejected)).status, 'rejected');
  assert.deepEqual(await placesNamed('Doublon du Resto U'), []);
  const mine = await readData(await phone.call('/contributors/me/proposals'));
  assert.deepEqual([mine[0].status, mine[0].reviewNote], ['rejected', 'Déjà sur la carte']);
  const again = await accept(proposal.id);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'PROPOSAL_ALREADY_REVIEWED');
  assert.equal((await accept('inconnue')).status, 404);
  assert.equal(
    (await reviewerCall(`/proposals/${proposal.id}`, { method: 'PATCH', body: { status: 'pending' } })).status,
    400,
  );
});

databaseTest('marquer un signalement comme traité ne modifie pas la carte', async () => {
  const phone = await joinAsPhone();
  const target = await insertExistingPlace('place_signalee', 'Bibliothèque centrale');
  const report = await phone.propose({
    entityType: 'place',
    action: 'report',
    targetId: target.id,
    payload: { message: 'Horaires faux' },
  });
  assert.equal((await readData(await reviewerCall(`/proposals/${report.id}`))).target.name, 'Bibliothèque centrale');
  const before = (await readCampusMap(database)).places;
  assert.equal((await readData(await accept(report.id))).status, 'accepted');
  assert.deepEqual((await readCampusMap(database)).places, before);
});

databaseTest('accepter une correction malgré un conflit, signalé au relecteur', async () => {
  const phone = await joinAsPhone();
  const target = await insertExistingPlace('place_conflit', 'Rectorat');
  const correction = await phone.propose({
    entityType: 'place',
    action: 'update',
    targetId: target.id,
    payload: { ...target, name: 'Rectorat de l’UAC' },
  });
  assert.equal((await readData(await reviewerCall(`/proposals/${correction.id}`))).hasConflict, false);
  await adminCall(`/places/${target.id}`, { method: 'PUT', body: { ...target, access: 'Rez-de-chaussée' } });
  const detail = await readData(await reviewerCall(`/proposals/${correction.id}`));
  assert.deepEqual([detail.hasConflict, detail.target.access], [true, 'Rez-de-chaussée']);
  assert.equal((await accept(correction.id)).status, 200);
  assert.equal((await findPlace(database, target.id)).name, 'Rectorat de l’UAC');
  const reviewed = await readData(await reviewerCall(`/proposals/${correction.id}`));
  assert.deepEqual([reviewed.status, reviewed.hasConflict], ['accepted', false]);
});

databaseTest('une proposition dont la cible a disparu reste en attente', async () => {
  const phone = await joinAsPhone();
  const target = await insertExistingPlace('place_disparue', 'Ancien kiosque');
  const correction = await phone.propose({
    entityType: 'place',
    action: 'update',
    targetId: target.id,
    payload: { ...target, name: 'Kiosque rénové' },
  });
  await adminCall(`/places/${target.id}`, { method: 'DELETE' });
  const response = await accept(correction.id);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'TARGET_NOT_FOUND');
  const detail = await readData(await reviewerCall(`/proposals/${correction.id}`));
  assert.deepEqual([detail.status, detail.hasConflict, detail.target], ['pending', true, null]);
});

databaseTest('deux relecteurs qui acceptent en même temps ne publient qu’une fois', async () => {
  const phone = await joinAsPhone();
  const proposal = await phone.propose(newPlace('Kiosque disputé'));
  const adminCookie = await openSession(ADMIN_TOKEN);
  const responses = await Promise.all([
    accept(proposal.id),
    accept(proposal.id, (path, options) => callApi(path, { ...options, cookie: adminCookie })),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await placesNamed('Kiosque disputé')).length, 1);
});

databaseTest('bloquer un téléphone refuse ses propositions en attente et ses envois suivants', async () => {
  const phone = await joinAsPhone();
  const first = await phone.propose(newPlace('Envoi douteux 1'));
  const second = await phone.propose(newPlace('Envoi douteux 2'));
  const blocked = await reviewerCall(`/contributors/${phone.contributor.id}`, {
    method: 'PATCH',
    body: { status: 'blocked' },
  });
  const contributor = await readData(blocked);
  assert.deepEqual([contributor.status, contributor.pendingCount, contributor.rejectedCount], ['blocked', 0, 2]);
  for (const proposal of [first, second]) {
    assert.equal((await readData(await reviewerCall(`/proposals/${proposal.id}`))).status, 'rejected');
  }
  const next = await phone.call('/proposals', {
    method: 'POST',
    body: { ...newPlace('Envoi douteux 3'), devicePosition: onCampus() },
  });
  assert.equal(next.status, 403);
  const blockedList = await readData(await reviewerCall('/contributors?status=blocked'));
  assert.ok(blockedList.some((candidate) => candidate.id === phone.contributor.id));
  const unknown = await reviewerCall('/contributors/inconnu', { method: 'PATCH', body: { status: 'trusted' } });
  assert.equal(unknown.status, 404);
  const invalid = await reviewerCall(`/contributors/${phone.contributor.id}`, {
    method: 'PATCH',
    body: { status: 'chef' },
  });
  assert.equal(invalid.status, 400);
});

databaseTest('un blocage pendant un envoi ne laisse aucune proposition en attente', async () => {
  for (let round = 0; round < 10; round += 1) {
    const phone = await joinAsPhone();
    const [sent, blocked] = await Promise.all([
      phone.call('/proposals', {
        method: 'POST',
        body: { ...newPlace(`Envoi concurrent ${round}`), devicePosition: onCampus() },
      }),
      reviewerCall(`/contributors/${phone.contributor.id}`, { method: 'PATCH', body: { status: 'blocked' } }),
    ]);
    assert.equal(blocked.status, 200);
    if (sent.status === 403) assert.equal((await sent.json()).error.code, 'CONTRIBUTOR_BLOCKED');
    else assert.equal(sent.status, 201);
    const [rows] = await database.execute(
      "SELECT COUNT(*) AS total FROM proposals WHERE contributor_id = ? AND `status` = 'pending'",
      [phone.contributor.id],
    );
    assert.equal(Number(rows[0].total), 0, `tour ${round}`);
  }
});

databaseTest('accorder la confiance permet de publier directement', async () => {
  const phone = await joinAsPhone();
  await reviewerCall(`/contributors/${phone.contributor.id}`, { method: 'PATCH', body: { status: 'trusted' } });
  const proposal = await phone.propose(newPlace('Publié par confiance'));
  assert.equal(proposal.status, 'accepted');
  assert.equal((await placesNamed('Publié par confiance')).length, 1);
});

databaseTest('annule pas à pas, de la modification la plus récente à la plus ancienne', async () => {
  const [longitude, latitude] = offsetPosition(80, 80);
  const created = await adminCall('/places', {
    method: 'POST',
    body: { name: 'Amphi 1000', category: 'lecture-hall', longitude, latitude },
  });
  const place = await readData(created);
  await adminCall(`/places/${place.id}`, { method: 'PUT', body: { ...place, name: 'Amphi 1000 places' } });
  await adminCall(`/places/${place.id}`, { method: 'PUT', body: { ...place, name: 'Amphi Mille' } });
  const history = await readData(await reviewerCall(`/map-changes?entity-type=place&entity-id=${place.id}`));
  assert.deepEqual(
    history.map((change) => change.action),
    ['update', 'update', 'create'],
  );
  const [latestUpdate, firstUpdate, creation] = history;
  const revert = (change) => reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId: change.id } });

  const outdated = await revert(firstUpdate);
  assert.deepEqual([outdated.status, (await outdated.json()).error.code], [409, 'CHANGE_OUTDATED']);

  const reverted = await revert(latestUpdate);
  assert.equal(reverted.status, 201);
  const revertChange = await readData(reverted);
  assert.deepEqual(
    [revertChange.action, revertChange.revertsChangeId, revertChange.actorName],
    ['revert', latestUpdate.id, 'Aïcha'],
  );
  assert.equal((await findPlace(database, place.id)).name, 'Amphi 1000 places');

  assert.equal((await revert(firstUpdate)).status, 201);
  assert.equal((await findPlace(database, place.id)).name, 'Amphi 1000');
  assert.equal((await revert(creation)).status, 201);
  assert.equal(await findPlace(database, place.id), null);
  assert.equal((await revert(latestUpdate)).status, 409);
});

databaseTest('annuler la suppression d’un lieu le remet à l’identique', async () => {
  const [longitude, latitude] = offsetPosition(90, -70);
  const created = await adminCall('/places', {
    method: 'POST',
    body: { name: 'Salle des actes', category: 'administration', aliases: ['Actes'], longitude, latitude },
  });
  const place = await readData(created);
  assert.equal((await adminCall(`/places/${place.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(await findPlace(database, place.id), null);
  const [deletion] = await readData(await reviewerCall(`/map-changes?entity-type=place&entity-id=${place.id}`));
  assert.equal(deletion.action, 'delete');
  const reverted = await reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId: deletion.id } });
  assert.equal(reverted.status, 201);
  assert.deepEqual(await findPlace(database, place.id), place);
});

databaseTest('annuler la modification d’un chemin remet son nom d’avant, tracé inchangé', async () => {
  const coordinates = [offsetPosition(0, 100), offsetPosition(30, 100)];
  const created = await adminCall('/paths', { method: 'POST', body: { name: 'Allée des flamboyants', coordinates } });
  const path = await readData(created);
  const renamed = await adminCall(`/paths/${path.id}`, { method: 'PATCH', body: { name: 'Allée du Doyen' } });
  assert.equal((await readData(renamed)).name, 'Allée du Doyen');
  const [change] = await readData(await reviewerCall(`/map-changes?entity-type=path&entity-id=${path.id}`));
  assert.equal(change.action, 'update');
  const reverted = await reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId: change.id } });
  assert.equal(reverted.status, 201);
  const restored = await readData(await callApi(`/paths/${path.id}`));
  assert.deepEqual([restored.name, restored.coordinates], [path.name, path.coordinates]);
});

databaseTest('refuse d’annuler une opération en masse, une modification inconnue ou mal désignée', async () => {
  const bulkId = await recordMapChange(database, { entityType: 'map', action: 'bulk', actor: COMMAND_ACTOR });
  const bulk = await reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId: bulkId } });
  assert.deepEqual([bulk.status, (await bulk.json()).error.code], [409, 'CHANGE_NOT_REVERTIBLE']);
  const unknown = await reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId: bulkId + 1000 } });
  assert.deepEqual([unknown.status, (await unknown.json()).error.code], [404, 'CHANGE_NOT_FOUND']);
  for (const revertsChangeId of ['12', 0, 1.5, null]) {
    const invalid = await reviewerCall('/map-changes', { method: 'POST', body: { revertsChangeId } });
    assert.equal(invalid.status, 400, String(revertsChangeId));
  }
});

databaseTest('refuse les routes de relecture sans session du mode collecte', async () => {
  const phone = await joinAsPhone();
  const routes = [
    ['GET', '/proposals'],
    ['GET', '/proposals/x'],
    ['PATCH', '/proposals/x'],
    ['GET', '/contributors'],
    ['PATCH', '/contributors/x'],
    ['GET', '/map-changes'],
    ['POST', '/map-changes'],
  ];
  for (const [method, path] of routes) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await callApi(path, { method, body })).status, 401, `${method} ${path} anonyme`);
    assert.equal((await phone.call(path, { method, body })).status, 401, `${method} ${path} contributeur`);
  }
});
