/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createDatabasePool } from '../server/database/connection.js';

test('répond 500 générique quand la base est injoignable, et reste en service', async () => {
  const unreachable = createDatabasePool({
    host: '127.0.0.1',
    port: 1,
    database: 'uac_map_test',
    user: 'personne',
    password: 'mot-de-passe-a-ne-pas-afficher',
  });
  const server = createApp({ database: unreachable, adminToken: 'jeton-de-test-1234' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/v1/campus-map`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: 'INTERNAL_ERROR', message: 'Erreur interne', status: 500 },
    });
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
  } finally {
    server.close();
    await unreachable.end();
  }
});
