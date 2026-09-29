/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sessions du mode collecte. Le jeton d'accès n'est échangé qu'une fois contre un identifiant de session
// aléatoire, stocké dans un cookie httpOnly inaccessible au JavaScript de la page.

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

export class AdminSessionRegistry {
  constructor() {
    this.expirations = new Map();
  }

  create() {
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    this.expirations.set(sessionId, expiresAt);
    this.removeExpired();
    return { sessionId, expiresAt };
  }

  getExpiration(sessionId) {
    const expiresAt = sessionId ? this.expirations.get(sessionId) : undefined;
    if (!expiresAt) return null;
    if (Date.now() > expiresAt) {
      this.expirations.delete(sessionId);
      return null;
    }
    return expiresAt;
  }

  revoke(sessionId) {
    this.expirations.delete(sessionId);
  }

  removeExpired() {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.expirations) if (now > expiresAt) this.expirations.delete(sessionId);
  }
}

export function readCookie(request, name) {
  const header = request.get('cookie') || '';
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === name) return decodeURIComponent(part.slice(separatorIndex + 1).trim());
  }
  return '';
}

// Limite les essais de jeton : 10 échecs par client sur 15 minutes. La clé reste en mémoire, jamais journalisée.
export class FailedAttemptLimiter {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  isBlocked(clientKey) {
    const entry = this.failures.get(clientKey);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.failures.delete(clientKey);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(clientKey) {
    const entry = this.failures.get(clientKey);
    if (!entry || Date.now() > entry.resetAt)
      this.failures.set(clientKey, { count: 1, resetAt: Date.now() + this.windowMs });
    else entry.count++;
  }

  recordSuccess(clientKey) {
    this.failures.delete(clientKey);
  }
}
