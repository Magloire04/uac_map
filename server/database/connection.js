/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import mysql from 'mysql2/promise';

// Les hébergements mutualisés limitent le nombre de connexions par utilisateur.
export const DATABASE_POOL_SIZE = 5;

// Dates converties en UTC. Requêtes multiples interdites : seule la commande de migration les autorise,
// sur sa propre connexion.
export function createDatabasePool(configuration) {
  return mysql.createPool({
    ...configuration,
    connectionLimit: DATABASE_POOL_SIZE,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    multipleStatements: false,
  });
}

export async function withTransaction(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const outcome = await work(connection);
    await connection.commit();
    return outcome;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Verrou nommé MariaDB, tenu sur une connexion réservée pendant toute la durée de « work ».
export async function withNamedLock(pool, lockName, work, timeoutSeconds = 30) {
  const connection = await pool.getConnection();
  try {
    const [[{ isLocked }]] = await connection.query('SELECT GET_LOCK(?, ?) AS isLocked', [lockName, timeoutSeconds]);
    if (isLocked !== 1) throw new Error(`Verrou ${lockName} indisponible après ${timeoutSeconds} s`);
    try {
      return await work(connection);
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    connection.release();
  }
}
