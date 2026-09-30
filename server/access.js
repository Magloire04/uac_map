/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Accès au mode collecte : cookie de session (appli web) ou en-tête Bearer avec ADMIN_TOKEN (scripts).
// Une session appartient à l'administrateur ou à un relecteur ; son auteur est posé sur request.actor.

import {
  SESSION_COOKIE_NAME,
  createClientDigest,
  createTokenDigest,
  createTokenFingerprint,
  isSameSecret,
  readCookie,
} from './adminSessions.js';
import { ADMIN_ACTOR } from './actors.js';
import { findAdminSession } from './database/adminSessionRepository.js';
import { clearFailedAttempts, reserveLoginAttempt } from './database/failedLoginAttemptRepository.js';
import { asyncRoute, sendError } from './http.js';
import { logSecurityEvent } from './securityLog.js';

export function createStaffAccess({ database, adminToken, getNow }) {
  const tokenDigest = createTokenDigest(adminToken);
  const tokenFingerprint = createTokenFingerprint(adminToken);
  const getClientDigest = (request) => createClientDigest(request.ip, adminToken);

  const findSession = (request) =>
    findAdminSession(database, readCookie(request, SESSION_COOKIE_NAME), tokenFingerprint, getNow());

  async function identifyStaff(request) {
    const session = await findSession(request);
    if (session) return session.actor;
    const header = request.get('authorization') || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!bearerToken) return null;
    const clientDigest = getClientDigest(request);
    if ((await reserveLoginAttempt(database, clientDigest, getNow())) && isSameSecret(bearerToken, tokenDigest)) {
      await clearFailedAttempts(database, clientDigest);
      return ADMIN_ACTOR;
    }
    return null;
  }

  const requireStaff = asyncRoute(async (request, response, next) => {
    const actor = await identifyStaff(request);
    if (actor) {
      request.actor = actor;
      return next();
    }
    logSecurityEvent(
      'admin_access_denied',
      { requestId: request.requestId, method: request.method, path: request.path },
      'warn',
    );
    sendError(response, 401, 'UNAUTHORIZED', 'Session du mode collecte absente ou expirée');
  });

  return { tokenDigest, tokenFingerprint, getClientDigest, findSession, requireStaff };
}
