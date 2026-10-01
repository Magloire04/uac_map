/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Onglet « Administration », réservé à l'administrateur : suspension des contributions, liens de contribution,
// relecteurs. Le jeton d'un nouveau relecteur n'est montré qu'une fois, dans une boîte dédiée, puis effacé.

import { html } from '/safeHtml.js';
import { formatDateTime } from '/proposalLabels.js';

const LIST_LIMIT = 100;
const LINK_CHANGES = {
  public: { body: { isPublic: true }, message: 'Ce lien est désormais le lien public du site' },
  close: {
    body: { isActive: false },
    message: "Lien fermé : il n'accepte plus de nouveaux téléphones",
    confirmation: 'Fermer ce lien ? Les téléphones déjà inscrits gardent leur accès.',
  },
  reopen: { body: { isActive: true }, message: 'Lien rouvert' },
};

const selectElement = (selector) => document.querySelector(selector);

function describeLinkStatus(link) {
  if (!link.isActive) return `Fermé le ${formatDateTime(link.closedAt)}`;
  return link.isPublic ? 'Public, affiché sur le site' : 'Actif';
}

export function createAdministrationTab(panel) {
  const { context } = panel;
  const tokenDialog = selectElement('#token-dialog');
  let reviewers = [];
  let links = [];

  tokenDialog.addEventListener('close', () => {
    selectElement('#token-value').value = '';
  });
  selectElement('#token-copy').addEventListener('click', async () => {
    const tokenField = selectElement('#token-value');
    try {
      await navigator.clipboard.writeText(tokenField.value);
      context.showToast('Jeton copié');
    } catch {
      tokenField.select();
    }
  });

  async function load() {
    const [reviewerPage, linkPage] = await Promise.all([
      panel.callStaffApi('GET', `/reviewers?limit=${LIST_LIMIT}`),
      panel.callStaffApi('GET', `/contribution-links?limit=${LIST_LIMIT}`),
    ]);
    reviewers = reviewerPage.data;
    links = linkPage.data;
  }

  const linkButton = (link, change, label, extraClass = '') =>
    html`<button
      class="button small${extraClass}"
      data-action="link-update"
      data-link-id="${link.id}"
      data-change="${change}"
      type="button"
    >
      ${label}
    </button>`;

  const renderLink = (link) =>
    html`<li>
      <strong>${link.label}</strong> · ${describeLinkStatus(link)}
      <span class="note">${link.url}</span>
      <div class="row">
        <button class="button small" data-action="link-copy" data-url="${link.url}" type="button">
          Copier le lien
        </button>
        ${link.isActive && !link.isPublic ? linkButton(link, 'public', 'Rendre public') : ''}
        ${link.isPublic ? html`<a class="button small" href="/qr.html" target="_blank" rel="noopener">Imprimer le QR code</a>` : ''}
        ${link.isActive ? linkButton(link, 'close', 'Fermer', ' danger') : linkButton(link, 'reopen', 'Rouvrir')}
      </div>
    </li>`;

  const renderReviewer = (reviewer) =>
    html`<li>
      <strong>${reviewer.name}</strong> ·
      ${
        reviewer.isActive
          ? `actif depuis le ${formatDateTime(reviewer.createdAt)}`
          : `révoqué le ${formatDateTime(reviewer.revokedAt)}`
      }
      ${
        reviewer.isActive
          ? html`<div class="row">
              <button
                class="button small danger"
                data-action="reviewer-revoke"
                data-reviewer-id="${reviewer.id}"
                data-reviewer-name="${reviewer.name}"
                type="button"
              >
                Révoquer
              </button>
            </div>`
          : ''
      }
    </li>`;

  function render() {
    const settings = context.state.campusMap?.settings;
    return html`
      <h3>Contributions</h3>
      <label class="switch-row"
        ><input
          type="checkbox"
          data-setting="contributionsPaused"
          ${settings?.contributionsPaused ? html`checked` : ''}
        />
        Suspendre les contributions</label
      >
      ${
        settings && !settings.perimeter
          ? html`<p class="warning">
              Périmètre du campus non importé : lancez <code>npm run import-perimeter</code> sur le serveur.
            </p>`
          : ''
      }
      <h3>Liens de contribution</h3>
      ${
        links.length
          ? html`<ul class="review-list">
              ${links.map(renderLink)}
            </ul>`
          : html`<p class="note">Aucun lien.</p>`
      }
      <div class="row">
        <input
          type="text"
          id="new-link-label"
          maxlength="80"
          placeholder="Libellé, ex. Promo L2 géographie"
          aria-label="Libellé du nouveau lien"
        />
        <label><input type="checkbox" id="new-link-public" /> Lien public</label>
        <button class="button small primary" data-action="link-create" type="button">Créer le lien</button>
      </div>
      <h3>Relecteurs</h3>
      ${
        reviewers.length
          ? html`<ul class="review-list">
              ${reviewers.map(renderReviewer)}
            </ul>`
          : html`<p class="note">Aucun relecteur.</p>`
      }
      <div class="row">
        <input
          type="text"
          id="new-reviewer-name"
          maxlength="80"
          placeholder="Nom du relecteur"
          aria-label="Nom du nouveau relecteur"
        />
        <button class="button small primary" data-action="reviewer-create" type="button">Créer le relecteur</button>
      </div>
    `;
  }

  const actions = {
    'link-copy': async (button) => {
      await navigator.clipboard.writeText(button.dataset.url);
      context.showToast('Lien copié');
    },
    'link-create': async () => {
      await panel.callStaffApi('POST', '/contribution-links', {
        label: selectElement('#new-link-label').value,
        isPublic: selectElement('#new-link-public').checked,
      });
      context.showToast('Lien créé');
      await load();
    },
    'link-update': async (button) => {
      const change = LINK_CHANGES[button.dataset.change];
      if (change.confirmation && !confirm(change.confirmation)) return;
      await panel.callStaffApi(
        'PATCH',
        `/contribution-links/${encodeURIComponent(button.dataset.linkId)}`,
        change.body,
      );
      context.showToast(change.message);
      await load();
    },
    'reviewer-create': async () => {
      const { data } = await panel.callStaffApi('POST', '/reviewers', {
        name: selectElement('#new-reviewer-name').value,
      });
      selectElement('#token-reviewer-name').textContent = data.name;
      selectElement('#token-value').value = data.token;
      tokenDialog.showModal();
      await load();
    },
    'reviewer-revoke': async (button) => {
      if (!confirm(`Révoquer ${button.dataset.reviewerName} ? Ses sessions seront fermées.`)) return;
      await panel.callStaffApi('DELETE', `/reviewers/${encodeURIComponent(button.dataset.reviewerId)}`);
      context.showToast('Relecteur révoqué');
      await load();
    },
  };

  async function onChange(event) {
    if (event.target.dataset.setting !== 'contributionsPaused') return;
    const isPaused = event.target.checked;
    await panel.callStaffApi('PATCH', '/campus-settings', { contributionsPaused: isPaused });
    await context.reloadCampusMap();
    context.showToast(isPaused ? 'Contributions suspendues' : 'Contributions rouvertes');
  }

  return {
    id: 'administration',
    label: 'Administration',
    isVisible: () => panel.getStaffSession()?.role === 'admin',
    load,
    render,
    actions,
    onChange,
  };
}
