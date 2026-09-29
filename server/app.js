/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import express from 'express';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CampusMapStore } from './store.js';
import { logSecurityEvent, logError } from './securityLog.js';
import {
  AdminSessionRegistry,
  FailedAttemptLimiter,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  createTokenDigest,
  isSameSecret,
  readCookie,
} from './adminSessions.js';
import { cleanPlace, cleanPath, ValidationError } from '../shared/validate.js';
import { PLACE_CATEGORIES } from '../shared/search.js';
import { PATH_TYPES } from '../shared/graph.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TILE_HOSTS = ['https://tile.openstreetmap.org', 'https://server.arcgisonline.com'];
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MIN_ADMIN_TOKEN_LENGTH = 12;

// Erreur métier transportée jusqu'au gestionnaire d'erreurs, qui produit l'enveloppe standard.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sendError = (response, status, code, message) =>
  response.status(status).json({ error: { code, message, status } });

function setSecurityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `img-src 'self' data: blob: ${TILE_HOSTS.join(' ')}`,
      `connect-src 'self' ${TILE_HOSTS.join(' ')}`,
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

// X-Request-ID : repris du client s'il est bien formé, sinon généré, et renvoyé dans la réponse.
function assignRequestId(request, response, next) {
  const incomingId = request.get('x-request-id');
  request.requestId = incomingId && /^[A-Za-z0-9-]{8,64}$/.test(incomingId) ? incomingId : randomUUID();
  response.set('X-Request-ID', request.requestId);
  next();
}

function readPagination(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT), 10);
  if (!Number.isInteger(page) || page < 1)
    throw new ApiError(400, 'INVALID_PAGE', 'Le paramètre page doit être un entier ≥ 1');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ApiError(400, 'INVALID_LIMIT', `Le paramètre limit doit être compris entre 1 et ${MAX_PAGE_LIMIT}`);
  }
  const sortBy = query['sort-by'] ?? 'name';
  if (!['id', 'name'].includes(sortBy)) throw new ApiError(400, 'INVALID_SORT', 'sort-by accepte id ou name');
  const order = query.order ?? 'asc';
  if (!['asc', 'desc'].includes(order)) throw new ApiError(400, 'INVALID_ORDER', 'order accepte asc ou desc');
  return { page, limit, sortBy, order };
}

function paginate(items, { page, limit, sortBy, order }) {
  const direction = order === 'asc' ? 1 : -1;
  const sorted = items
    .slice()
    .sort((first, second) => direction * String(first[sortBy] ?? '').localeCompare(String(second[sortBy] ?? ''), 'fr'));
  return {
    data: sorted.slice((page - 1) * limit, page * limit),
    meta: { page, limit, total: items.length },
  };
}

function buildGeoJson(campusMap) {
  const features = [
    ...campusMap.paths.map(({ coordinates, ...properties }) => ({
      type: 'Feature',
      properties: { kind: 'path', ...properties },
      geometry: { type: 'LineString', coordinates },
    })),
    ...campusMap.places.map(({ longitude, latitude, entrances, ...properties }) => ({
      type: 'Feature',
      properties: { kind: 'place', ...properties },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    })),
    ...campusMap.places.flatMap((place) =>
      place.entrances.map((entrance, index) => ({
        type: 'Feature',
        properties: {
          kind: 'entrance',
          placeId: place.id,
          placeName: place.name,
          position: index + 1,
          note: entrance.note,
        },
        geometry: { type: 'Point', coordinates: [entrance.longitude, entrance.latitude] },
      })),
    ),
  ];
  return { type: 'FeatureCollection', features };
}

export function createApp({ store, adminToken, publicUrl = '' }) {
  if (!(store instanceof CampusMapStore)) throw new Error('store requis');
  if (!adminToken || adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`ADMIN_TOKEN trop court (${MIN_ADMIN_TOKEN_LENGTH} caractères minimum)`);
  }
  const tokenDigest = createTokenDigest(adminToken);
  const sessions = new AdminSessionRegistry();
  const limiter = new FailedAttemptLimiter();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(setSecurityHeaders);
  app.use(assignRequestId);
  app.use(express.json({ limit: '1mb' }));

  const writeSessionCookie = (request, response, sessionId, maxAgeMs) => {
    const attributes = [
      `${SESSION_COOKIE_NAME}=${sessionId}`,
      'Path=/api',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (request.secure) attributes.push('Secure');
    response.append('Set-Cookie', attributes.join('; '));
  };

  // Accès au mode collecte : cookie de session (appli web) ou en-tête Bearer avec le jeton (scripts).
  const requireAdmin = (request, response, next) => {
    const sessionExpiration = sessions.getExpiration(readCookie(request, SESSION_COOKIE_NAME));
    if (sessionExpiration) return next();
    const header = request.get('authorization') || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (bearerToken && !limiter.isBlocked(request.ip) && isSameSecret(bearerToken, tokenDigest)) {
      limiter.recordSuccess(request.ip);
      return next();
    }
    if (bearerToken) limiter.recordFailure(request.ip);
    logSecurityEvent(
      'admin_access_denied',
      {
        requestId: request.requestId,
        method: request.method,
        path: request.path,
      },
      'warn',
    );
    sendError(response, 401, 'UNAUTHORIZED', 'Session du mode collecte absente ou expirée');
  };

  const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
  const findPlace = (placeId) => store.campusMap.places.find((place) => place.id === placeId);
  const findPath = (pathId) => store.campusMap.paths.find((path) => path.id === pathId);

  const api = express.Router();

  api.get('/health', (_request, response) => response.json({ data: { status: 'ok' } }));

  // ---------- Session du mode collecte ----------

  api.post('/admin/session', (request, response) => {
    if (limiter.isBlocked(request.ip)) {
      logSecurityEvent('admin_login_blocked', { requestId: request.requestId }, 'warn');
      return sendError(response, 429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives, réessayez dans 15 minutes');
    }
    if (!isSameSecret(request.body?.token, tokenDigest)) {
      limiter.recordFailure(request.ip);
      logSecurityEvent('admin_login_failed', { requestId: request.requestId }, 'warn');
      return sendError(response, 401, 'INVALID_TOKEN', "Jeton d'accès incorrect");
    }
    limiter.recordSuccess(request.ip);
    const { sessionId, expiresAt } = sessions.create();
    writeSessionCookie(request, response, sessionId, SESSION_DURATION_MS);
    logSecurityEvent('admin_login_succeeded', { requestId: request.requestId });
    response.status(201).json({ data: { expiresAt: new Date(expiresAt).toISOString() } });
  });

  api.get('/admin/session', (request, response) => {
    const expiresAt = sessions.getExpiration(readCookie(request, SESSION_COOKIE_NAME));
    if (!expiresAt) return sendError(response, 401, 'UNAUTHORIZED', 'Aucune session active');
    response.json({ data: { expiresAt: new Date(expiresAt).toISOString() } });
  });

  api.delete('/admin/session', (request, response) => {
    sessions.revoke(readCookie(request, SESSION_COOKIE_NAME));
    writeSessionCookie(request, response, '', 0);
    logSecurityEvent('admin_logout', { requestId: request.requestId });
    response.status(204).end();
  });

  // ---------- Carte complète (utilisée par l'appli, qui calcule les itinéraires sur le téléphone) ----------

  api.get('/campus-map', (request, response) => {
    const format = request.query.format ?? 'json';
    if (format === 'geojson') {
      response.set('Content-Disposition', 'attachment; filename="campus-uac.geojson"');
      return response.type('application/geo+json').send(JSON.stringify(buildGeoJson(store.campusMap)));
    }
    if (format !== 'json') return sendError(response, 400, 'INVALID_FORMAT', 'format accepte json ou geojson');
    response.set('Cache-Control', 'no-cache');
    response.json({ data: store.campusMap });
  });

  api.delete(
    '/campus-map',
    requireAdmin,
    asyncRoute(async (request, response) => {
      if (request.query.confirm !== 'true') {
        throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Ajoutez ?confirm=true pour vider la carte');
      }
      await store.update((campusMap) => {
        campusMap.places = [];
        campusMap.paths = [];
        campusMap.settings.isDemo = false;
      });
      logSecurityEvent('campus_map_cleared', { requestId: request.requestId });
      response.status(204).end();
    }),
  );

  // ---------- Lieux ----------

  api.get('/places', (request, response) => {
    const pagination = readPagination(request.query);
    const search = String(request.query.search ?? '').toLowerCase();
    const category = request.query.category;
    if (category && !Object.hasOwn(PLACE_CATEGORIES, category)) {
      throw new ApiError(400, 'INVALID_CATEGORY', 'Catégorie inconnue');
    }
    const places = store.campusMap.places.filter(
      (place) =>
        (!category || place.category === category) &&
        (!search || [place.name, ...place.aliases].some((text) => text.toLowerCase().includes(search))),
    );
    response.json(paginate(places, pagination));
  });

  api.get('/places/:placeId', (request, response) => {
    const place = findPlace(request.params.placeId);
    if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
    response.json({ data: place });
  });

  api.post(
    '/places',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const place = { id: CampusMapStore.generateId('place'), ...cleanPlace(request.body) };
      await store.update((campusMap) => campusMap.places.push(place));
      logSecurityEvent('place_created', { requestId: request.requestId, resourceId: place.id });
      response.status(201).json({ data: place });
    }),
  );

  api.put(
    '/places/:placeId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const replacement = cleanPlace(request.body);
      const place = await store.update((campusMap) => {
        const existing = campusMap.places.find((candidate) => candidate.id === request.params.placeId);
        if (existing) Object.assign(existing, replacement);
        return existing;
      });
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      logSecurityEvent('place_updated', { requestId: request.requestId, resourceId: place.id });
      response.json({ data: place });
    }),
  );

  api.delete(
    '/places/:placeId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const isRemoved = await store.update((campusMap) => {
        const index = campusMap.places.findIndex((place) => place.id === request.params.placeId);
        if (index !== -1) campusMap.places.splice(index, 1);
        return index !== -1;
      });
      if (!isRemoved) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      logSecurityEvent('place_deleted', { requestId: request.requestId, resourceId: request.params.placeId });
      response.status(204).end();
    }),
  );

  // QR code « Vous êtes ici » : ouvre l'appli avec ce lieu comme point de départ.
  api.get(
    '/places/:placeId/qr-code',
    asyncRoute(async (request, response) => {
      const place = findPlace(request.params.placeId);
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      const baseUrl = (publicUrl || `${request.protocol}://${request.get('host')}`).replace(/\/$/, '');
      const targetUrl = `${baseUrl}/?ici=${encodeURIComponent(place.id)}`;
      const svg = await QRCode.toString(targetUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      response.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
    }),
  );

  // ---------- Chemins ----------

  api.get('/paths', (request, response) => {
    const pagination = readPagination({ 'sort-by': 'id', ...request.query });
    const type = request.query.type;
    if (type && !Object.hasOwn(PATH_TYPES, type))
      throw new ApiError(400, 'INVALID_PATH_TYPE', 'Type de chemin inconnu');
    const paths = store.campusMap.paths.filter((path) => !type || path.type === type);
    response.json(paginate(paths, pagination));
  });

  api.get('/paths/:pathId', (request, response) => {
    const path = findPath(request.params.pathId);
    if (!path) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
    response.json({ data: path });
  });

  api.post(
    '/paths',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const path = { id: CampusMapStore.generateId('path'), ...cleanPath(request.body) };
      await store.update((campusMap) => campusMap.paths.push(path));
      logSecurityEvent('path_created', { requestId: request.requestId, resourceId: path.id });
      response.status(201).json({ data: path });
    }),
  );

  // Mise à jour partielle : type, nom, caractère inondable. Le tracé ne change pas.
  api.patch(
    '/paths/:pathId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const body = request.body || {};
      const path = await store.update((campusMap) => {
        const existing = campusMap.paths.find((candidate) => candidate.id === request.params.pathId);
        if (!existing) return null;
        const { type, name, isFloodProne } = cleanPath({
          type: body.type ?? existing.type,
          name: body.name ?? existing.name,
          isFloodProne: body.isFloodProne ?? existing.isFloodProne,
          coordinates: existing.coordinates,
        });
        Object.assign(existing, { type, name, isFloodProne });
        return existing;
      });
      if (!path) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_updated', { requestId: request.requestId, resourceId: path.id });
      response.json({ data: path });
    }),
  );

  api.delete(
    '/paths/:pathId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const isRemoved = await store.update((campusMap) => {
        const index = campusMap.paths.findIndex((path) => path.id === request.params.pathId);
        if (index !== -1) campusMap.paths.splice(index, 1);
        return index !== -1;
      });
      if (!isRemoved) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_deleted', { requestId: request.requestId, resourceId: request.params.pathId });
      response.status(204).end();
    }),
  );

  api.use((_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));

  app.use('/api/v1', api);
  app.use('/api', (_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));
  app.use('/shared', express.static(join(PROJECT_ROOT, 'shared')));
  app.use('/vendor/maplibre', express.static(join(PROJECT_ROOT, 'node_modules/maplibre-gl/dist'), { maxAge: '7d' }));
  app.use(express.static(join(PROJECT_ROOT, 'public')));

  // Réponses d'erreur génériques : jamais de trace d'exécution envoyée au client.
  app.use((error, request, response, _next) => {
    if (error instanceof ValidationError) return sendError(response, 400, 'VALIDATION_ERROR', error.message);
    if (error instanceof ApiError) return sendError(response, error.status, error.code, error.message);
    if (error.type === 'entity.parse.failed') return sendError(response, 400, 'INVALID_JSON', 'JSON invalide');
    if (error.type === 'entity.too.large')
      return sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'Requête trop volumineuse');
    logError('server_error', error, { requestId: request.requestId });
    sendError(response, 500, 'INTERNAL_ERROR', 'Erreur interne');
  });

  return app;
}
