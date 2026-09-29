/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Lecture et contrôle de la configuration. Les messages d'erreur ne citent que des noms de variables,
// jamais leurs valeurs.

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readPort(rawValue, defaultPort, variableName) {
  const port = Number(rawValue || defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError(`${variableName} doit être un numéro de port valide`);
  }
  return port;
}

function assertPresent(environment, variableNames) {
  const missingNames = variableNames.filter((variableName) => !environment[variableName]);
  if (missingNames.length) {
    throw new ConfigurationError(`Variables d'environnement manquantes : ${missingNames.join(', ')}`);
  }
}

// Réglage « trust proxy » d'Express : true, false, un nombre de proxys ou une liste d'adresses.
export function parseTrustProxy(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function readDatabaseConfiguration(environment = process.env) {
  const isProduction = environment.NODE_ENV === 'production';
  assertPresent(environment, ['DATABASE_NAME', 'DATABASE_USER', ...(isProduction ? ['DATABASE_PASSWORD'] : [])]);
  return {
    host: environment.DATABASE_HOST || 'localhost',
    port: readPort(environment.DATABASE_PORT, 3306, 'DATABASE_PORT'),
    database: environment.DATABASE_NAME,
    user: environment.DATABASE_USER,
    password: environment.DATABASE_PASSWORD || '',
  };
}

export function readServerConfiguration(environment = process.env) {
  const isProduction = environment.NODE_ENV === 'production';
  assertPresent(environment, [
    'DATABASE_NAME',
    'DATABASE_USER',
    ...(isProduction ? ['DATABASE_PASSWORD', 'ADMIN_TOKEN', 'PUBLIC_URL'] : []),
  ]);
  return {
    isProduction,
    port: readPort(environment.PORT, 3000, 'PORT'),
    httpsPort: readPort(environment.HTTPS_PORT, 3443, 'HTTPS_PORT'),
    isHttpsEnabled: environment.HTTPS_ENABLED === 'true',
    adminToken: environment.ADMIN_TOKEN || null,
    publicUrl: environment.PUBLIC_URL || '',
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    database: readDatabaseConfiguration(environment),
  };
}
