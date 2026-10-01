/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// LIMIT et OFFSET passent en paramètres (chaînes, acceptées par MariaDB et MySQL 8) pour garder un texte SQL
// constant : une seule instruction préparée, quel que soit le numéro de page.
export function toPageParameters({ page, limit }) {
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || page < 1 || limit < 1) {
    throw new Error('Pagination invalide');
  }
  return [String(limit), String((page - 1) * limit)];
}
