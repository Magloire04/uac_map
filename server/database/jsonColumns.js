/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// MariaDB renvoie les colonnes JSON sous forme de texte, MySQL sous forme d'objet : on accepte les deux.
export const readJsonColumn = (value) => (typeof value === 'string' ? JSON.parse(value) : (value ?? null));

export const toJsonColumn = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
