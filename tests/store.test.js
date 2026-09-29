/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateCampusMap, SCHEMA_VERSION } from '../server/store.js';

test('convertit une carte du premier prototype vers le schéma actuel', () => {
  const legacy = {
    version: 1,
    meta: { demo: true, center: [2.3, 6.4] },
    places: [
      {
        id: 'p1',
        name: 'BU',
        category: 'bibliotheque',
        lon: 2.3,
        lat: 6.4,
        entrances: [{ lon: 2.31, lat: 6.41, note: 'Nord' }],
      },
    ],
    paths: [
      {
        id: 'c1',
        type: 'escaliers',
        inondable: true,
        coords: [
          [2.3, 6.4],
          [2.31, 6.41],
        ],
      },
    ],
  };
  const migrated = migrateCampusMap(legacy);
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.equal(migrated.settings.isDemo, true);
  assert.deepEqual(migrated.places[0].entrances[0], { longitude: 2.31, latitude: 6.41, note: 'Nord' });
  assert.equal(migrated.places[0].category, 'library');
  assert.equal(migrated.paths[0].type, 'stairs');
  assert.equal(migrated.paths[0].isFloodProne, true);
});
