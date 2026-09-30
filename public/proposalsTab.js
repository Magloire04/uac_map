/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onglet « Propositions » : file d'attente (de la plus ancienne à la plus récente), détail avec aperçu sur la
// carte, comparaison champ par champ pour une correction, et décision : accepter (publie, ou marque un
// signalement comme traité) ou refuser avec une note.

import { html } from '/safeHtml.js';
import { PLACE_CATEGORIES } from '/shared/search.js';
import { PATH_TYPES } from '/shared/graph.js';
import { getLineLength } from '/shared/geo.js';
import { formatDistance } from '/shared/instructions.js';
import { listPlaceChanges } from '/shared/proposalDiff.js';
import {
  CONTRIBUTOR_STATUS_LABELS,
  describeProposalKind,
  describeProposalStatus,
  formatDateTime,
  summarizeProposal,
} from '/proposalLabels.js';
import { optionTag, renderPager } from '/panelWidgets.js';

const PAGE_LIMIT = 20;

export function createProposalsTab(panel) {
  const { context } = panel;
  const filters = { status: 'pending', entityType: '' };
  let page = 1;
  let list = { data: [], meta: { page: 1, limit: PAGE_LIMIT, total: 0 } };
  let detail = null;

  async function loadList() {
    const query = new URLSearchParams({
      status: filters.status,
      page: String(page),
      limit: String(PAGE_LIMIT),
      order: filters.status === 'pending' ? 'asc' : 'desc',
    });
    if (filters.entityType) query.set('entity-type', filters.entityType);
    list = await panel.callStaffApi('GET', `/proposals?${query}`);
    detail = null;
    panel.clearMap();
  }

  // ---------- Aperçu sur la carte ----------

  // Point d'un lieu et de ses entrées, ou tracé d'un chemin. role : current (version actuelle), proposed
  // (proposition) ou reported (élément signalé), repris par le style de la couche « review ».
  function toPreviewFeatures(entityType, element, role) {
    if (entityType === 'place') {
      return [
        context.toPointFeature([element.longitude, element.latitude], { role }),
        ...element.entrances.map((entrance) =>
          context.toPointFeature([entrance.longitude, entrance.latitude], { role }),
        ),
      ];
    }
    return [context.toLineFeature(element.coordinates, { role })];
  }

  function showDetailOnMap() {
    const { entityType, action, payload, target } = detail;
    const features = [
      ...(target ? toPreviewFeatures(entityType, target, action === 'report' ? 'reported' : 'current') : []),
      ...(action === 'report' ? [] : toPreviewFeatures(entityType, payload, 'proposed')),
    ];
    panel.showOnMap(features);
    const coordinates = features.flatMap((feature) =>
      feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates,
    );
    if (coordinates.length) panel.fitTo(coordinates);
  }

  async function openDetail(proposalId) {
    ({ data: detail } = await panel.callStaffApi('GET', `/proposals/${encodeURIComponent(proposalId)}`));
    showDetailOnMap();
  }

  // ---------- Contenu ----------

  const renderPlaceFields = (place) =>
    html`<table class="field-table">
      <tbody>
        <tr>
          <th>Nom</th>
          <td>${place.name}</td>
        </tr>
        <tr>
          <th>Catégorie</th>
          <td>${PLACE_CATEGORIES[place.category] || place.category}</td>
        </tr>
        <tr>
          <th>Autres noms</th>
          <td>${place.aliases.join(', ') || '—'}</td>
        </tr>
        <tr>
          <th>Description</th>
          <td>${place.description || '—'}</td>
        </tr>
        <tr>
          <th>Accès</th>
          <td>${place.access || '—'}</td>
        </tr>
        <tr>
          <th>Entrées</th>
          <td>${place.entrances.length}</td>
        </tr>
      </tbody>
    </table>`;

  function renderPlaceChanges(target, payload) {
    const changes = listPlaceChanges(target, payload);
    if (!changes.length) return html`<p class="note">Aucune différence avec la version actuelle.</p>`;
    return html`<table class="field-table">
      <thead>
        <tr>
          <th></th>
          <th>Actuel</th>
          <th>Proposé</th>
        </tr>
      </thead>
      <tbody>
        ${changes.map(
          (change) =>
            html`<tr>
              <th>${change.label}</th>
              <td>${change.before}</td>
              <td class="is-proposed">${change.after}</td>
            </tr>`,
        )}
      </tbody>
    </table>`;
  }

  const renderPathFields = (path) =>
    html`<table class="field-table">
      <tbody>
        <tr>
          <th>Type</th>
          <td>${PATH_TYPES[path.type] || path.type}</td>
        </tr>
        <tr>
          <th>Nom</th>
          <td>${path.name || '—'}</td>
        </tr>
        <tr>
          <th>Inondable</th>
          <td>${path.isFloodProne ? 'Oui' : 'Non'}</td>
        </tr>
        <tr>
          <th>Longueur</th>
          <td>${formatDistance(getLineLength(path.coordinates))} · ${path.coordinates.length} points</td>
        </tr>
      </tbody>
    </table>`;

  function renderContent({ entityType, action, payload, target }) {
    if (action === 'report') {
      const targetName = !target
        ? 'élément supprimé'
        : entityType === 'place'
          ? target.name
          : target.name || PATH_TYPES[target.type];
      return html`<p><strong>${entityType === 'place' ? 'Lieu' : 'Chemin'} :</strong> ${targetName}</p>
        <blockquote class="report-message">${payload.message}</blockquote>`;
    }
    if (entityType === 'path') return renderPathFields(payload);
    if (action === 'update' && target) return renderPlaceChanges(target, payload);
    return renderPlaceFields(payload);
  }

  function renderConflict({ hasConflict, target }) {
    if (!hasConflict) return '';
    return target
      ? html`<p class="warning">
          L'élément visé a changé depuis l'envoi : comparez avec sa version actuelle avant d'accepter.
        </p>`
      : html`<p class="warning">L'élément visé a été supprimé depuis l'envoi.</p>`;
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

  function renderContributor(contributor) {
    if (!contributor) return html`<p class="note">Contributeur supprimé.</p>`;
    const actions =
      contributor.status === 'blocked'
        ? ''
        : html`${
            contributor.status === 'trusted'
              ? statusButton(contributor, 'new', 'Retirer la confiance')
              : statusButton(contributor, 'trusted', 'Faire confiance')
          }
          ${statusButton(contributor, 'blocked', 'Bloquer ce téléphone', ' danger')}`;
    return html`<p class="note">
        Contributeur : <strong>${contributor.pseudonym || 'sans pseudo'}</strong> ·
        ${CONTRIBUTOR_STATUS_LABELS[contributor.status]} · ${contributor.acceptedCount} acceptée(s),
        ${contributor.rejectedCount} refusée(s), ${contributor.pendingCount} en attente
      </p>
      <div class="row">${actions}</div>`;
  }

  function renderDecision({ action, target }) {
    const canAccept = action === 'report' || action === 'create' || Boolean(target);
    return html`<label class="field"
        ><span>Note au contributeur <small>(facultative, 300 caractères)</small></span
        ><textarea id="review-note" maxlength="300"></textarea>
      </label>
      <div class="actions">
        <button class="button primary" data-action="proposal-accept" type="button" ${canAccept ? '' : html`disabled`}>
          ${action === 'report' ? 'Marquer comme traité' : 'Accepter et publier'}
        </button>
        <button class="button danger" data-action="proposal-reject" type="button">Refuser</button>
      </div>`;
  }

  function renderDetail() {
    const proposal = detail;
    return html`
      <div class="row">
        <button class="button small" data-action="proposal-back" type="button">Retour à la liste</button>
      </div>
      <h3>${describeProposalKind(proposal)}</h3>
      <p class="note">
        Envoyée le ${formatDateTime(proposal.createdAt)} · position vérifiée à ±
        ${Math.round(proposal.positionAccuracyMeters)} m · ${describeProposalStatus(proposal)}
      </p>
      ${renderConflict(proposal)} ${renderContent(proposal)} ${renderContributor(proposal.contributor)}
      ${proposal.reviewNote ? html`<p class="note">Note : ${proposal.reviewNote}</p>` : ''}
      ${proposal.status === 'pending' ? renderDecision(proposal) : ''}
    `;
  }

  function renderList() {
    const { data, meta } = list;
    const items = data.length
      ? html`<ul class="review-list">
          ${data.map(
            (proposal) =>
              html`<li>
                <button type="button" data-action="proposal-open" data-proposal-id="${proposal.id}">
                  <strong>${describeProposalKind(proposal)}</strong> · ${summarizeProposal(proposal)}
                  <span class="note">
                    ${proposal.contributor?.pseudonym || 'Sans pseudo'} · ${formatDateTime(proposal.createdAt)} ·
                    ${describeProposalStatus(proposal)}
                  </span>
                </button>
              </li>`,
          )}
        </ul>`
      : html`<p class="note">Aucune proposition.</p>`;
    return html`
      <div class="row">
        <select data-filter="status" aria-label="État des propositions">
          ${optionTag('pending', 'En attente', filters.status)} ${optionTag('accepted', 'Acceptées', filters.status)}
          ${optionTag('rejected', 'Refusées', filters.status)} ${optionTag('', 'Toutes', filters.status)}
        </select>
        <select data-filter="entityType" aria-label="Type d'élément">
          ${optionTag('', 'Lieux et chemins', filters.entityType)} ${optionTag('place', 'Lieux', filters.entityType)}
          ${optionTag('path', 'Chemins', filters.entityType)}
        </select>
      </div>
      ${items} ${renderPager(meta)}
    `;
  }

  // ---------- Décisions ----------

  function describeDecision(status, action) {
    if (status === 'rejected') return 'Proposition refusée';
    return action === 'report' ? 'Signalement traité' : 'Proposition publiée';
  }

  async function decide(status) {
    const noteField = document.querySelector('#review-note');
    const { data } = await panel.callStaffApi('PATCH', `/proposals/${encodeURIComponent(detail.id)}`, {
      status,
      note: noteField ? noteField.value : '',
    });
    context.showToast(describeDecision(status, data.action));
    if (status === 'accepted' && data.action !== 'report') await context.reloadCampusMap();
    await Promise.all([loadList(), panel.refreshPendingCount()]);
  }

  const actions = {
    'proposal-open': (button) => openDetail(button.dataset.proposalId),
    'proposal-back': loadList,
    'proposal-accept': () => decide('accepted'),
    'proposal-reject': () => decide('rejected'),
    'contributor-status': async (button) => {
      await panel.changeContributorStatus(button.dataset.contributorId, button.dataset.status);
      await openDetail(detail.id);
    },
    'page-previous': () => {
      page = Math.max(1, page - 1);
      return loadList();
    },
    'page-next': () => {
      page += 1;
      return loadList();
    },
  };

  async function onChange(event) {
    const filterName = event.target.dataset.filter;
    if (!filterName || !Object.hasOwn(filters, filterName)) return;
    filters[filterName] = event.target.value;
    page = 1;
    await loadList();
  }

  return {
    id: 'proposals',
    label: () => `Propositions (${panel.getPendingCount()})`,
    load: loadList,
    render: () => (detail ? renderDetail() : renderList()),
    actions,
    onChange,
  };
}
