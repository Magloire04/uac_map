/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Éléments communs aux onglets du panneau de relecture.

import { html } from '/safeHtml.js';

export const optionTag = (value, label, currentValue) =>
  html`<option value="${value}" ${value === currentValue ? html`selected` : ''}>${label}</option>`;

export const lastPageOf = ({ limit, total }) => Math.max(1, Math.ceil(total / limit));

// Pagination : chaque onglet gère les actions « page-previous » et « page-next ».
export function renderPager({ page, limit, total }) {
  const pageCount = lastPageOf({ limit, total });
  if (pageCount === 1) return '';
  return html`<div class="row">
    <button class="button small" data-action="page-previous" type="button" ${page > 1 ? '' : html`disabled`}>
      Précédent
    </button>
    <span class="note">Page ${page} sur ${pageCount}</span>
    <button class="button small" data-action="page-next" type="button" ${page < pageCount ? '' : html`disabled`}>
      Suivant
    </button>
  </div>`;
}
