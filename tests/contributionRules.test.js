/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDevicePosition,
  cleanContributorStatus,
  cleanProposal,
  cleanPseudonym,
  cleanReview,
  isGeometryInsidePerimeter,
  isPublishedDirectly,
  listProposalPoints,
  MAX_POSITION_AGE_MS,
} from '../server/contributionRules.js';
import { ValidationError } from '../shared/validate.js';
import { createSquarePerimeter, offsetPosition } from './helpers.js';

const perimeter = createSquarePerimeter(500);
const [farLongitude, farLatitude] = offsetPosition(3000, 0);
const [placeLongitude, placeLatitude] = offsetPosition(30, 40);
const placePayload = { name: 'Kiosque', category: 'food', longitude: placeLongitude, latitude: placeLatitude };

const onCampus = (overrides = {}) => {
  const [longitude, latitude] = offsetPosition(10, 20);
  return { longitude, latitude, accuracy: 12, ageMs: 3000, ...overrides };
};

test('accepte une position récente et précise sur le campus', () => {
  assert.equal(checkDevicePosition(onCampus(), perimeter), null);
});

test('refuse une position absente ou mal formée', () => {
  const malformed = [
    undefined,
    null,
    'ici',
    [],
    {},
    onCampus({ longitude: '2.34' }),
    onCampus({ latitude: Number.NaN }),
    onCampus({ accuracy: -1 }),
    onCampus({ latitude: 95 }),
    onCampus({ ageMs: undefined }),
  ];
  for (const devicePosition of malformed) {
    assert.equal(checkDevicePosition(devicePosition, perimeter), 'POSITION_REQUIRED', String(devicePosition));
  }
});

test('refuse une position loin du campus, imprécise ou trop ancienne', () => {
  const far = onCampus({ longitude: farLongitude, latitude: farLatitude });
  assert.equal(checkDevicePosition(far, perimeter), 'OUTSIDE_CAMPUS');
  assert.equal(checkDevicePosition(onCampus({ accuracy: 51 }), perimeter), 'POSITION_INACCURATE');
  assert.equal(checkDevicePosition(onCampus({ ageMs: MAX_POSITION_AGE_MS + 1 }), perimeter), 'POSITION_TOO_OLD');
  assert.equal(checkDevicePosition(onCampus(), null), 'OUTSIDE_CAMPUS');
});

test('valide une création de lieu comme le mode collecte', () => {
  const proposal = cleanProposal({ entityType: 'place', action: 'create', payload: placePayload, targetId: 'ignoré' });
  assert.equal(proposal.targetId, null);
  assert.equal(proposal.payload.name, 'Kiosque');
  assert.deepEqual(proposal.payload.aliases, []);
});

test('exige une cible pour une correction ou un signalement', () => {
  assert.throws(() => cleanProposal({ entityType: 'place', action: 'update', payload: placePayload }), ValidationError);
  assert.throws(
    () => cleanProposal({ entityType: 'path', action: 'report', targetId: ['x'], payload: { message: 'Boue' } }),
    ValidationError,
  );
  const report = cleanProposal({
    entityType: 'path',
    action: 'report',
    targetId: 'path_1',
    payload: { message: '  Flaque\u0000 profonde ' },
  });
  assert.deepEqual(report, {
    entityType: 'path',
    action: 'report',
    targetId: 'path_1',
    payload: { message: 'Flaque profonde' },
  });
});

test("refuse ce qu'un contributeur ne peut pas proposer", () => {
  const refused = [
    null,
    { entityType: 'campus', action: 'create', payload: placePayload },
    { entityType: 'place', action: 'delete', targetId: 'place_1', payload: {} },
    { entityType: 'path', action: 'update', targetId: 'path_1', payload: { coordinates: [] } },
    { entityType: 'place', action: 'report', targetId: 'place_1', payload: { message: 'x'.repeat(501) } },
    { entityType: 'place', action: 'report', targetId: 'place_1', payload: { message: '   ' } },
    { entityType: 'place', action: 'create', payload: { name: 'Sans position' } },
  ];
  for (const input of refused) assert.throws(() => cleanProposal(input), ValidationError, JSON.stringify(input));
});

test('contrôle chaque point proposé dans le périmètre', () => {
  const place = cleanProposal({
    entityType: 'place',
    action: 'create',
    payload: { ...placePayload, entrances: [{ longitude: farLongitude, latitude: farLatitude }] },
  });
  assert.equal(listProposalPoints(place).length, 2);
  assert.equal(isGeometryInsidePerimeter(listProposalPoints(place), perimeter), false);
  const path = cleanProposal({
    entityType: 'path',
    action: 'create',
    payload: { coordinates: [offsetPosition(0, 0), offsetPosition(100, 0)] },
  });
  assert.equal(isGeometryInsidePerimeter(listProposalPoints(path), perimeter), true);
  const report = cleanProposal({ entityType: 'place', action: 'report', targetId: 'p', payload: { message: 'Fermé' } });
  assert.deepEqual(listProposalPoints(report), []);
});

test('publie directement pour un contributeur de confiance, sauf un signalement', () => {
  const creation = { action: 'create' };
  assert.equal(isPublishedDirectly({ status: 'trusted' }, creation), true);
  assert.equal(isPublishedDirectly({ status: 'new' }, creation), false);
  assert.equal(isPublishedDirectly({ status: 'trusted' }, { action: 'report' }), false);
});

test('valide une relecture, un statut de contributeur et un pseudo', () => {
  assert.deepEqual(cleanReview({ status: 'rejected', note: ' Doublon ' }), { status: 'rejected', note: 'Doublon' });
  assert.deepEqual(cleanReview({ status: 'accepted' }), { status: 'accepted', note: null });
  assert.throws(() => cleanReview({ status: 'pending' }), ValidationError);
  assert.throws(() => cleanReview(undefined), ValidationError);
  assert.throws(() => cleanReview({ status: 'rejected', note: 'x'.repeat(301) }), ValidationError);
  assert.equal(cleanContributorStatus({ status: 'trusted' }), 'trusted');
  assert.throws(() => cleanContributorStatus({ status: 'admin' }), ValidationError);
  assert.equal(cleanPseudonym('  Awa  '), 'Awa');
  assert.equal(cleanPseudonym(''), null);
  assert.equal(cleanPseudonym(undefined), null);
  assert.throws(() => cleanPseudonym('x'.repeat(41)), ValidationError);
});
