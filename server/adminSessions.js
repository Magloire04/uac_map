/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Secrets du mode collecte. Le jeton d'accès n'est échangé qu'une fois contre un identifiant de session
// aléatoire, gardé dans un cookie httpOnly. La base ne reçoit que des empreintes : jamais le jeton,
// l'identifiant de session ni l'adresse du client en clair.

import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'uac_admin_session';
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

const hashValue = (value) => createHash('sha256').update(String(value)).digest();

export function isSameSecret(candidate, expectedDigest) {
  return Boolean(candidate) && timingSafeEqual(hashValue(candidate), expectedDigest);
}

export function createTokenDigest(adminToken) {
  return hashValue(adminToken);
}

// Rangée avec chaque session : changer ADMIN_TOKEN ferme toutes les sessions ouvertes avec l'ancien jeton.
export function createTokenFingerprint(adminToken) {
  return hashValue(`uac-map:session-token:${adminToken}`);
}

export function createSessionId() {
  return randomBytes(32).toString('base64url');
}

export function createSessionDigest(sessionId) {
  return hashValue(sessionId);
}

// HMAC de l'adresse du client, avec une clé dérivée du jeton : impossible à inverser sans le jeton.
export function createClientDigest(clientAddress, adminToken) {
  return createHmac('sha256', hashValue(`uac-map:client-key:${adminToken}`))
    .update(String(clientAddress))
    .digest();
}

// Un cookie mal encodé est traité comme absent.
export function readCookie(request, name) {
  const header = request.get('cookie') || '';
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1 || part.slice(0, separatorIndex).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}
