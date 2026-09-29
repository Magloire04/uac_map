/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigurationError,
  parseTrustProxy,
  readDatabaseConfiguration,
  readServerConfiguration,
} from '../server/configuration.js';

const databaseEnvironment = { DATABASE_NAME: 'uac_map', DATABASE_USER: 'uac_map' };
const productionEnvironment = {
  ...databaseEnvironment,
  NODE_ENV: 'production',
  DATABASE_PASSWORD: 'mot-de-passe-secret',
  ADMIN_TOKEN: 'jeton-de-production-123456',
  PUBLIC_URL: 'https://uacmap.bytechnum.com',
};

test('applique les valeurs par défaut de connexion à la base', () => {
  assert.deepEqual(readDatabaseConfiguration(databaseEnvironment), {
    host: 'localhost',
    port: 3306,
    database: 'uac_map',
    user: 'uac_map',
    password: '',
  });
});

test('refuse une configuration sans nom de base ni utilisateur, en nommant les variables', () => {
  assert.throws(
    () => readDatabaseConfiguration({}),
    (error) => error instanceof ConfigurationError && /DATABASE_NAME, DATABASE_USER/.test(error.message),
  );
});

test('refuse un port de base invalide', () => {
  assert.throws(() => readDatabaseConfiguration({ ...databaseEnvironment, DATABASE_PORT: 'abc' }), /DATABASE_PORT/);
});

test('exige le jeton et l’adresse publique en production, sans recopier les valeurs fournies', () => {
  assert.throws(
    () =>
      readServerConfiguration({
        ...databaseEnvironment,
        NODE_ENV: 'production',
        DATABASE_PASSWORD: 'mot-de-passe-secret',
      }),
    (error) =>
      error instanceof ConfigurationError &&
      /ADMIN_TOKEN, PUBLIC_URL/.test(error.message) &&
      !error.message.includes('mot-de-passe-secret'),
  );
});

test('exige le mot de passe de la base en production', () => {
  const { DATABASE_PASSWORD: _password, ...withoutPassword } = productionEnvironment;
  assert.throws(() => readServerConfiguration(withoutPassword), /DATABASE_PASSWORD/);
});

test('lit la configuration complète du serveur en production', () => {
  const configuration = readServerConfiguration(productionEnvironment);
  assert.equal(configuration.isProduction, true);
  assert.equal(configuration.adminToken, 'jeton-de-production-123456');
  assert.equal(configuration.publicUrl, 'https://uacmap.bytechnum.com');
  assert.equal(configuration.trustProxy, 'loopback');
  assert.equal(configuration.port, 3000);
  assert.equal(configuration.database.password, 'mot-de-passe-secret');
});

test('hors production, le jeton et le mot de passe peuvent manquer', () => {
  const configuration = readServerConfiguration(databaseEnvironment);
  assert.equal(configuration.isProduction, false);
  assert.equal(configuration.adminToken, null);
});

test('interprète TRUST_PROXY comme le réglage trust proxy d’Express', () => {
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy(''), 'loopback');
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy(' loopback, 10.0.0.0/8 '), 'loopback, 10.0.0.0/8');
});
