/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Accès aux lieux, aux chemins et aux réglages de la carte. Chaque fonction reçoit un « executor » : le pool,
// ou une connexion ouverte par withTransaction. Les dates viennent toujours du JavaScript (paramètre now).

import { randomUUID } from 'node:crypto';
import { withNamedLock, withTransaction } from './connection.js';
import { createEmptyCampusMap, SCHEMA_VERSION } from '../campusMapDefaults.js';

const INITIALISATION_LOCK = 'uac_map_initialisation';
const SORTABLE_COLUMNS = { id: 'id', name: 'name' };
const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' };
const PLACE_COLUMNS = 'id, name, category, aliases, description, `access`, longitude, latitude, entrances';
const PATH_COLUMNS = 'id, `type`, name, is_flood_prone, coordinates';
const SETTINGS_COLUMNS = 'name, center_longitude, center_latitude, zoom, is_demo, updated_at';

export function generateId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

// MariaDB renvoie les colonnes JSON sous forme de texte, MySQL sous forme d'objet : on accepte les deux.
const readJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

const toPlace = (row) => ({
  id: row.id,
  name: row.name,
  category: row.category,
  aliases: readJson(row.aliases),
  description: row.description,
  access: row.access,
  longitude: row.longitude,
  latitude: row.latitude,
  entrances: readJson(row.entrances),
});

const toPath = (row) => ({
  id: row.id,
  type: row.type,
  name: row.name,
  isFloodProne: Boolean(row.is_flood_prone),
  coordinates: readJson(row.coordinates),
});

const toSettings = (row) => ({
  name: row.name,
  center: [row.center_longitude, row.center_latitude],
  zoom: row.zoom,
  isDemo: Boolean(row.is_demo),
  updatedAt: row.updated_at.toISOString(),
});

const placeValues = (place) => [
  place.name,
  place.category,
  JSON.stringify(place.aliases),
  place.description,
  place.access,
  place.longitude,
  place.latitude,
  JSON.stringify(place.entrances),
];

// Recherche du texte tel quel : « ! » sert de caractère d'échappement pour %, _ et lui-même.
const toContainsPattern = (text) => `%${text.replace(/[!%_]/g, (character) => `!${character}`)}%`;

// ORDER BY ne peut pas être un paramètre : la colonne et le sens viennent d'une liste fermée. LIMIT et OFFSET
// passent en paramètres (chaînes, acceptées par MariaDB et MySQL 8) pour garder un texte SQL constant : sinon,
// chaque numéro de page créerait une instruction préparée de plus sur le serveur, partagé sur l'hébergement.
function buildPageClause({ page, limit, sortBy, order }) {
  const isValid =
    Object.hasOwn(SORTABLE_COLUMNS, sortBy) &&
    Object.hasOwn(SORT_DIRECTIONS, order) &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger(limit) &&
    page >= 1 &&
    limit >= 1;
  if (!isValid) throw new Error('Pagination invalide');
  const direction = SORT_DIRECTIONS[order];
  return {
    clause: `ORDER BY ${SORTABLE_COLUMNS[sortBy]} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    parameters: [String(limit), String((page - 1) * limit)],
  };
}

async function listRows(executor, { table, columns, conditions, parameters, pagination }) {
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const page = buildPageClause(pagination);
  const [[{ total }]] = await executor.execute(`SELECT COUNT(*) AS total FROM ${table} ${whereClause}`, parameters);
  const [rows] = await executor.execute(`SELECT ${columns} FROM ${table} ${whereClause} ${page.clause}`, [
    ...parameters,
    ...page.parameters,
  ]);
  return { rows, total: Number(total) };
}

async function touchSettings(executor, now) {
  await executor.execute('UPDATE campus_settings SET updated_at = ? WHERE id = 1', [now]);
}

async function insertPlaceRow(executor, place, now, createdAt = now) {
  await executor.execute(
    'INSERT INTO places (id, name, category, aliases, description, `access`, longitude, latitude, entrances, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [place.id, ...placeValues(place), createdAt, now],
  );
}

async function insertPathRow(executor, path, now, createdAt = now) {
  await executor.execute(
    'INSERT INTO paths (id, `type`, name, is_flood_prone, coordinates, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [path.id, path.type, path.name, path.isFloodProne, JSON.stringify(path.coordinates), createdAt, now],
  );
}

export async function readSettings(executor) {
  const [rows] = await executor.execute(`SELECT ${SETTINGS_COLUMNS} FROM campus_settings WHERE id = 1`);
  return rows.length ? toSettings(rows[0]) : null;
}

export async function readCampusMap(executor, { isLocking = false } = {}) {
  const lockClause = isLocking ? ' FOR UPDATE' : '';
  const [placeRows] = await executor.execute(`SELECT ${PLACE_COLUMNS} FROM places ORDER BY id${lockClause}`);
  const [pathRows] = await executor.execute(`SELECT ${PATH_COLUMNS} FROM paths ORDER BY id${lockClause}`);
  return {
    version: SCHEMA_VERSION,
    settings: (await readSettings(executor)) ?? createEmptyCampusMap().settings,
    places: placeRows.map(toPlace),
    paths: pathRows.map(toPath),
  };
}

export async function listPlaces(executor, { page, limit, sortBy, order, category, search }) {
  const conditions = [];
  const parameters = [];
  if (category) {
    conditions.push('category = ?');
    parameters.push(category);
  }
  if (search) {
    const pattern = toContainsPattern(search);
    conditions.push(
      "(name LIKE ? ESCAPE '!' OR CAST(aliases AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci LIKE ? ESCAPE '!')",
    );
    parameters.push(pattern, pattern);
  }
  const { rows, total } = await listRows(executor, {
    table: 'places',
    columns: PLACE_COLUMNS,
    conditions,
    parameters,
    pagination: { page, limit, sortBy, order },
  });
  return { items: rows.map(toPlace), total };
}

export async function findPlace(executor, placeId) {
  const [rows] = await executor.execute(`SELECT ${PLACE_COLUMNS} FROM places WHERE id = ?`, [placeId]);
  return rows.length ? toPlace(rows[0]) : null;
}

export async function insertPlace(executor, place, now = new Date()) {
  await insertPlaceRow(executor, place, now);
  await touchSettings(executor, now);
}

export async function replacePlace(executor, placeId, fields, now = new Date()) {
  const [result] = await executor.execute(
    'UPDATE places SET name = ?, category = ?, aliases = ?, description = ?, `access` = ?, longitude = ?, latitude = ?, entrances = ?, updated_at = ? WHERE id = ?',
    [...placeValues(fields), now, placeId],
  );
  if (result.affectedRows === 0) return null;
  await touchSettings(executor, now);
  return { id: placeId, ...fields };
}

export async function deletePlace(executor, placeId, now = new Date()) {
  const [result] = await executor.execute('DELETE FROM places WHERE id = ?', [placeId]);
  if (result.affectedRows === 0) return false;
  await touchSettings(executor, now);
  return true;
}

export async function listPaths(executor, { page, limit, sortBy, order, type }) {
  const conditions = type ? ['`type` = ?'] : [];
  const { rows, total } = await listRows(executor, {
    table: 'paths',
    columns: PATH_COLUMNS,
    conditions,
    parameters: type ? [type] : [],
    pagination: { page, limit, sortBy, order },
  });
  return { items: rows.map(toPath), total };
}

export async function findPath(executor, pathId) {
  const [rows] = await executor.execute(`SELECT ${PATH_COLUMNS} FROM paths WHERE id = ?`, [pathId]);
  return rows.length ? toPath(rows[0]) : null;
}

export async function insertPath(executor, path, now = new Date()) {
  await insertPathRow(executor, path, now);
  await touchSettings(executor, now);
}

export async function updatePathAttributes(executor, pathId, { type, name, isFloodProne }, now = new Date()) {
  const [result] = await executor.execute(
    'UPDATE paths SET `type` = ?, name = ?, is_flood_prone = ?, updated_at = ? WHERE id = ?',
    [type, name, isFloodProne, now, pathId],
  );
  if (result.affectedRows === 0) return null;
  await touchSettings(executor, now);
  return findPath(executor, pathId);
}

export async function deletePath(executor, pathId, now = new Date()) {
  const [result] = await executor.execute('DELETE FROM paths WHERE id = ?', [pathId]);
  if (result.affectedRows === 0) return false;
  await touchSettings(executor, now);
  return true;
}

// « table » vient toujours du code (places ou paths), jamais d'une requête.
async function readCreationDates(executor, table) {
  const [rows] = await executor.execute(`SELECT id, created_at FROM ${table}`);
  return new Map(rows.map((row) => [row.id, row.created_at]));
}

// Remplace tout le contenu de la carte en une transaction. « transform » reçoit la carte actuelle, lignes
// verrouillées, et renvoie la nouvelle : vider la carte, charger la démonstration, importer OpenStreetMap.
export async function rewriteCampusMap(pool, transform, now = new Date()) {
  return withTransaction(pool, async (connection) => {
    const next = await transform(await readCampusMap(connection, { isLocking: true }));
    // Les lignes conservées gardent leur date de création : seules les nouvelles prennent « now ».
    const placeCreationDates = await readCreationDates(connection, 'places');
    const pathCreationDates = await readCreationDates(connection, 'paths');
    await connection.execute('DELETE FROM places');
    await connection.execute('DELETE FROM paths');
    for (const place of next.places) await insertPlaceRow(connection, place, now, placeCreationDates.get(place.id));
    for (const path of next.paths) await insertPathRow(connection, path, now, pathCreationDates.get(path.id));
    const { name, center, zoom, isDemo } = next.settings;
    const settingsValues = [name, center[0], center[1], zoom, isDemo, now];
    await connection.execute(
      `INSERT INTO campus_settings (id, name, center_longitude, center_latitude, zoom, is_demo, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = ?, center_longitude = ?, center_latitude = ?, zoom = ?, is_demo = ?, updated_at = ?`,
      [...settingsValues, ...settingsValues],
    );
    return readCampusMap(connection);
  });
}

// Premier lancement (aucun réglage en base) : démonstration hors production, carte vide en production.
// Le verrou évite que deux copies de l'application qui démarrent ensemble initialisent deux fois.
export async function initialiseCampusMap(pool, { isProduction, buildDemoCampusMap }, now = new Date()) {
  return withNamedLock(pool, INITIALISATION_LOCK, async () => {
    if (await readSettings(pool)) return 'existing';
    if (isProduction) {
      await rewriteCampusMap(pool, () => createEmptyCampusMap(now), now);
      return 'empty';
    }
    await rewriteCampusMap(pool, () => buildDemoCampusMap(), now);
    return 'demo';
  });
}
