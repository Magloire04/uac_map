/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Panneau de relecture du mode collecte, dans le panneau du bas (à gauche sur grand écran). Un module par onglet ;
// chaque onglet fournit load() (lecture de l'API), render() (contenu), actions (boutons data-action) et, s'il a des
// filtres, onChange(event). Les actions passent par runAction, qui affiche l'erreur éventuelle puis redessine.

import { html } from '/safeHtml.js';
import { createProposalsTab } from '/proposalsTab.js';
import { createContributorsTab } from '/contributorsTab.js';
import { createHistoryTab } from '/historyTab.js';

const COUNTER_REFRESH_MS = 60 * 1000;
const STATUS_CHANGE_MESSAGES = {
  new: 'Contributeur remis au statut « nouveau »',
  trusted: 'Confiance accordée : ses ajouts seront publiés directement',
  blocked: 'Téléphone bloqué : ses propositions en attente sont refusées',
};

export function createReviewPanel(context, { callStaffApi, getStaffSession, onRequestClose, onCountChange }) {
  const { state, showToast } = context;
  let isOpen = false;
  let currentTabId = 'proposals';
  let pendingCount = 0;
  let counterTimer = null;
  let isBusy = false;

  async function changeContributorStatus(contributorId, status) {
    if (
      status === 'blocked' &&
      !confirm('Bloquer ce téléphone ? Toutes ses propositions en attente seront refusées.')
    ) {
      return;
    }
    await callStaffApi('PATCH', `/contributors/${encodeURIComponent(contributorId)}`, { status });
    showToast(STATUS_CHANGE_MESSAGES[status]);
    await refreshPendingCount();
  }

  async function refreshPendingCount() {
    try {
      const { meta } = await callStaffApi('GET', '/proposals?status=pending&limit=1');
      if (meta.total !== pendingCount) {
        pendingCount = meta.total;
        onCountChange();
      }
    } catch {
      // Session expirée : callStaffApi ferme déjà le mode collecte. Autre erreur : le compteur garde sa valeur et le
      // prochain rafraîchissement réessaiera.
    }
  }

  // Outils communs, passés à chaque onglet.
  const panel = {
    context,
    callStaffApi,
    getStaffSession,
    getPendingCount: () => pendingCount,
    refreshPendingCount,
    changeContributorStatus,
    showOnMap: (features) => context.setSourceData('review', context.toFeatureCollection(features)),
    clearMap: () => context.setSourceData('review', context.toFeatureCollection([])),
    fitTo: (coordinates) => context.fitCoordinates(coordinates),
  };

  const tabs = [createProposalsTab(panel), createContributorsTab(panel), createHistoryTab(panel)];
  const visibleTabs = () => tabs.filter((tab) => tab.isVisible?.() ?? true);
  const currentTab = () => tabs.find((tab) => tab.id === currentTabId);

  // Une seule action à la fois : sur le réseau lent du campus, un second appui pendant l'envoi serait refusé (409).
  async function runAction(work) {
    if (isBusy) return;
    isBusy = true;
    try {
      await work();
    } catch (error) {
      // Session expirée (401) : callStaffApi a déjà fermé le mode collecte et affiché son message.
      if (error.status !== 401) showToast(error.message, 5000);
    } finally {
      isBusy = false;
    }
    render();
  }

  function render() {
    if (!isOpen) return;
    const session = getStaffSession();
    const subtitle = session?.role === 'reviewer' ? `Relecteur : ${session.name}` : 'Administrateur';
    context.openSheet(html`
      ${context.sheetHeader('Relecture', subtitle, 'Fermer la relecture', 'close-review')}
      <div class="tab-list" role="tablist">
        ${visibleTabs().map(
          (tab) =>
            html`<button
              class="tab${tab.id === currentTabId ? ' is-active' : ''}"
              data-action="review-tab"
              data-tab="${tab.id}"
              role="tab"
              aria-selected="${tab.id === currentTabId ? 'true' : 'false'}"
              type="button"
            >
              ${typeof tab.label === 'function' ? tab.label() : tab.label}
            </button>`,
        )}
      </div>
      <div class="tab-content">${currentTab().render()}</div>
    `);
  }

  function switchTab(tabId) {
    const tab = visibleTabs().find((candidate) => candidate.id === tabId) ?? tabs[0];
    currentTabId = tab.id;
    panel.clearMap();
    return runAction(() => tab.load());
  }

  function handleSheetAction(actionName, button) {
    if (actionName === 'close-review') {
      onRequestClose();
    } else if (actionName === 'review-tab') {
      switchTab(button.dataset.tab);
    } else {
      const handler = currentTab().actions[actionName];
      if (handler) runAction(() => handler(button));
    }
  }

  // Seuls les filtres (data-filter) et les réglages (data-setting) déclenchent un rechargement : un champ texte ou une
  // case de formulaire émet aussi « change » en perdant le focus, et redessiner effacerait la saisie en cours.
  function handleSheetChange(event) {
    const tab = currentTab();
    const { filter, setting } = event.target.dataset;
    if (tab.onChange && (filter || setting)) runAction(() => tab.onChange(event));
  }

  function open() {
    isOpen = true;
    state.hooks.onSheetAction = handleSheetAction;
    state.hooks.onSheetChange = handleSheetChange;
    return switchTab(currentTabId);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    isBusy = false;
    state.hooks.onSheetAction = null;
    state.hooks.onSheetChange = null;
    panel.clearMap();
    context.closeSheet();
  }

  function startCounter() {
    stopCounter();
    refreshPendingCount();
    counterTimer = setInterval(refreshPendingCount, COUNTER_REFRESH_MS);
  }

  function stopCounter() {
    clearInterval(counterTimer);
    counterTimer = null;
  }

  return { open, close, startCounter, stopCounter, getPendingCount: () => pendingCount };
}
