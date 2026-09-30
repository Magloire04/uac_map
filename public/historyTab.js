/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onglet « Historique » : modifications publiées, de la plus récente à la plus ancienne, avec leur auteur. Annuler
// remet l'élément dans son état d'avant ; le serveur refuse si l'élément a changé depuis (annuler d'abord les
// modifications plus récentes) ou s'il s'agit d'une opération en masse.

import { html } from '/safeHtml.js';
import { PATH_TYPES } from '/shared/graph.js';
import { formatDateTime } from '/proposalLabels.js';
import { lastPageOf, optionTag, renderPager } from '/panelWidgets.js';

const PAGE_LIMIT = 20;
const ACTION_LABELS = {
  create: 'Création',
  update: 'Modification',
  delete: 'Suppression',
  revert: 'Annulation',
  bulk: 'Opération en masse',
};

function describeActor({ actorKind, actorId, actorName }) {
  if (actorKind === 'admin') return 'Administrateur';
  if (actorKind === 'command') return 'Commande sur le serveur';
  if (actorKind === 'reviewer') return actorName ? `Relecteur ${actorName}` : 'Relecteur';
  return actorId ? `Contributeur ${actorName || 'sans pseudo'}` : 'Contributeur supprimé';
}

function describeElement({ entityType, entityId, beforeState, afterState }) {
  if (entityType === 'map') return 'Toute la carte';
  const element = afterState ?? beforeState;
  if (entityType === 'place') return `Lieu ${element?.name ?? entityId}`;
  return `Chemin ${element?.name || PATH_TYPES[element?.type] || entityId}`;
}

export function createHistoryTab(panel) {
  const { context } = panel;
  const filters = { entityType: '' };
  let page = 1;
  let list = { data: [], meta: { page: 1, limit: PAGE_LIMIT, total: 0 } };

  async function load() {
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (filters.entityType) query.set('entity-type', filters.entityType);
    list = await panel.callStaffApi('GET', `/map-changes?${query}`);
    // Page devenue vide (dernier élément traité) : retour à la dernière page qui existe.
    if (page > lastPageOf(list.meta)) {
      page = lastPageOf(list.meta);
      return load();
    }
  }

  function render() {
    const { data, meta } = list;
    const items = data.length
      ? html`<ul class="review-list">
          ${data.map(
            (change) =>
              html`<li>
                <strong>${ACTION_LABELS[change.action]}</strong> · ${describeElement(change)}
                <span class="note">${formatDateTime(change.createdAt)} · ${describeActor(change)}</span>
                ${
                  change.action === 'bulk'
                    ? ''
                    : html`<div class="row">
                        <button
                          class="button small"
                          data-action="change-revert"
                          data-change-id="${change.id}"
                          type="button"
                        >
                          Annuler
                        </button>
                      </div>`
                }
              </li>`,
          )}
        </ul>`
      : html`<p class="note">Aucune modification.</p>`;
    return html`
      <div class="row">
        <select data-filter="entityType" aria-label="Type d'élément">
          ${optionTag('', 'Tout', filters.entityType)} ${optionTag('place', 'Lieux', filters.entityType)}
          ${optionTag('path', 'Chemins', filters.entityType)} ${optionTag('map', 'Carte entière', filters.entityType)}
        </select>
      </div>
      ${items} ${renderPager(meta)}
    `;
  }

  const actions = {
    'change-revert': async (button) => {
      if (!confirm("Annuler cette modification ? L'élément retrouvera son état d'avant.")) return;
      await panel.callStaffApi('POST', '/map-changes', { revertsChangeId: Number(button.dataset.changeId) });
      context.showToast('Modification annulée');
      await context.reloadCampusMap();
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
    if (event.target.dataset.filter !== 'entityType') return;
    filters.entityType = event.target.value;
    page = 1;
    await load();
  }

  return { id: 'history', label: 'Historique', load, render, actions, onChange };
}
