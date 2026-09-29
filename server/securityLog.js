/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Journal de sécurité (une ligne JSON par événement sur la sortie standard).
// Ne jamais y écrire de jeton, de mot de passe, d'adresse IP ni de donnée personnelle.

const FORBIDDEN_KEYS = /^(token|adminToken|password|secret|cookie|authorization|ip|ipAddress|email)$/i;

export function logSecurityEvent(event, details = {}, level = 'info') {
  const safeDetails = Object.fromEntries(Object.entries(details).filter(([key]) => !FORBIDDEN_KEYS.test(key)));
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...safeDetails })}\n`);
}

export function logError(event, error, details = {}) {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'error', event, message: error.message, stack: error.stack, ...details })}\n`,
  );
}
