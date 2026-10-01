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
import { ADMIN_ACTOR, reviewerActor } from './actors.js';
import { findAdminSession } from './database/adminSessionRepository.js';
import { clearFailedAttempts, reserveLoginAttempt } from './database/failedLoginAttemptRepository.js';
import { findActiveReviewerByToken } from './database/reviewerRepository.js';
import { asyncRoute, sendError } from './http.js';
import { logSecurityEvent } from './securityLog.js';

// Ce que l'appli sait d'une session : son échéance, le rôle (admin ou reviewer) et le nom du relecteur.
export const toSessionView = ({ expiresAt, actor, reviewerName }) => ({
  expiresAt: expiresAt.toISOString(),
  role: actor.kind,
  name: reviewerName ?? null,
});

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

  // Jeton présenté à l'ouverture d'une session : ADMIN_TOKEN, ou jeton personnel d'un relecteur actif. La session
  // d'un relecteur garde l'empreinte de son propre jeton. L'en-tête Bearer, lui, reste réservé à ADMIN_TOKEN.
  async function identifyToken(token) {
    if (isSameSecret(token, tokenDigest)) return { actor: ADMIN_ACTOR, tokenFingerprint, reviewerName: null };
    const reviewer = await findActiveReviewerByToken(database, token);
    if (!reviewer) return null;
    return {
      actor: reviewerActor(reviewer.id),
      tokenFingerprint: createTokenFingerprint(token),
      reviewerName: reviewer.name,
    };
  }

  // Réservé à l'administrateur : relecteurs, liens, suspension, vider la carte.
  const checkAdministrator = (request, response, next) => {
    if (request.actor.kind === 'admin') return next();
    logSecurityEvent(
      'admin_action_forbidden',
      { requestId: request.requestId, method: request.method, path: request.path, reviewerId: request.actor.id },
      'warn',
    );
    sendError(response, 403, 'FORBIDDEN', 'Action réservée à l’administrateur');
  };
  const requireAdministrator = [requireStaff, checkAdministrator];

  return {
    tokenDigest,
    tokenFingerprint,
    getClientDigest,
    findSession,
    identifyToken,
    requireStaff,
    requireAdministrator,
  };
}
