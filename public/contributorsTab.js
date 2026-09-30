/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onglet « Contributeurs » : téléphones inscrits avec leur bilan ; confiance, blocage et déblocage.

import { html } from '/safeHtml.js';
import { CONTRIBUTOR_STATUS_LABELS, formatDateTime } from '/proposalLabels.js';
import { lastPageOf, optionTag, renderPager } from '/panelWidgets.js';

const PAGE_LIMIT = 20;

export function createContributorsTab(panel) {
  const filters = { status: '' };
  let page = 1;
  let list = { data: [], meta: { page: 1, limit: PAGE_LIMIT, total: 0 } };

  async function load() {
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (filters.status) query.set('status', filters.status);
    list = await panel.callStaffApi('GET', `/contributors?${query}`);
    // Page devenue vide (dernier élément traité) : retour à la dernière page qui existe.
    if (page > lastPageOf(list.meta)) {
      page = lastPageOf(list.meta);
      return load();
    }
  }

  const statusButton = (contributor, status, label, extraClass = '') =>
    html`<button
      class="button small${extraClass}"
      data-action="contributor-status"
      data-contributor-id="${contributor.id}"
      data-status="${status}"
      type="button"
    >
      ${label}
    </button>`;

  function renderActions(contributor) {
    if (contributor.status === 'blocked') return statusButton(contributor, 'new', 'Débloquer');
    return html`${
      contributor.status === 'trusted'
        ? statusButton(contributor, 'new', 'Retirer la confiance')
        : statusButton(contributor, 'trusted', 'Faire confiance')
    }
    ${statusButton(contributor, 'blocked', 'Bloquer', ' danger')}`;
  }

  function render() {
    const { data, meta } = list;
    const items = data.length
      ? html`<ul class="review-list">
          ${data.map(
            (contributor) =>
              html`<li>
                <strong>${contributor.pseudonym || 'Sans pseudo'}</strong> ·
                ${CONTRIBUTOR_STATUS_LABELS[contributor.status]}
                <span class="note">
                  ${contributor.acceptedCount} acceptée(s), ${contributor.rejectedCount} refusée(s),
                  ${contributor.pendingCount} en attente · vu le ${formatDateTime(contributor.lastSeenAt)}
                </span>
                <div class="row">${renderActions(contributor)}</div>
              </li>`,
          )}
        </ul>`
      : html`<p class="note">Aucun contributeur.</p>`;
    return html`
      <div class="row">
        <select data-filter="status" aria-label="Statut des contributeurs">
          ${optionTag('', 'Tous', filters.status)} ${optionTag('new', 'Nouveaux', filters.status)}
          ${optionTag('trusted', 'De confiance', filters.status)} ${optionTag('blocked', 'Bloqués', filters.status)}
        </select>
      </div>
      ${items} ${renderPager(meta)}
    `;
  }

  const actions = {
    'contributor-status': async (button) => {
      await panel.changeContributorStatus(button.dataset.contributorId, button.dataset.status);
      await load();
    },
    'page-previous': () => {
      page = Math.max(1, page - 1);
      return load();
    },
    'page-next': () => {
      page += 1;
      return load();
    },
  };

  async function onChange(event) {
    if (event.target.dataset.filter !== 'status') return;
    filters.status = event.target.value;
    page = 1;
    await load();
  }

  return { id: 'contributors', label: 'Contributeurs', load, render, actions, onChange };
}
