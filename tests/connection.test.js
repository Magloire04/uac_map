/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { withNamedLock, withTransaction } from '../server/database/connection.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, dropAllTestTables } from './testDatabase.js';

let database;

databaseBefore(async () => {
  await dropAllTestTables();
  database = createTestPool();
  await database.query('CREATE TABLE connection_probe (id INT PRIMARY KEY) ENGINE=InnoDB');
});

databaseAfter(async () => {
  await database.query('DROP TABLE IF EXISTS connection_probe');
  await database.end();
});

const countProbeRows = async () => {
  const [rows] = await database.execute('SELECT COUNT(*) AS total FROM connection_probe');
  return Number(rows[0].total);
};

databaseTest('annule toutes les écritures d’une transaction qui échoue', async () => {
  await assert.rejects(
    withTransaction(database, async (connection) => {
      await connection.execute('INSERT INTO connection_probe (id) VALUES (?)', [1]);
      await connection.execute('INSERT INTO connection_probe (id) VALUES (?)', [1]);
    }),
    { code: 'ER_DUP_ENTRY' },
  );
  assert.equal(await countProbeRows(), 0);
});

databaseTest('valide les écritures d’une transaction réussie et renvoie son résultat', async () => {
  const outcome = await withTransaction(database, async (connection) => {
    await connection.execute('INSERT INTO connection_probe (id) VALUES (?), (?)', [10, 11]);
    return 'terminé';
  });
  assert.equal(outcome, 'terminé');
  assert.equal(await countProbeRows(), 2);
});

databaseTest('un verrou nommé n’est tenu que par un seul appel à la fois', async () => {
  const events = [];
  const holdLock = (label) =>
    withNamedLock(database, 'uac_map_test_lock', async () => {
      events.push(`${label}:début`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push(`${label}:fin`);
    });
  await Promise.all([holdLock('premier'), holdLock('second')]);
  assert.deepEqual(
    events.map((event) => event.split(':')[1]),
    ['début', 'fin', 'début', 'fin'],
  );
});

databaseTest('écrit et relit les dates en UTC à la milliseconde', async () => {
  const [rows] = await database.execute('SELECT CAST(? AS DATETIME(3)) AS moment', [
    new Date('2026-09-29T08:30:00.123Z'),
  ]);
  assert.equal(rows[0].moment.toISOString(), '2026-09-29T08:30:00.123Z');
});
