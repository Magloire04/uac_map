/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mode collecte : relevé des lieux, entrées et chemins par l'équipe carto (session protégée). Ses écritures sont
// publiées directement ; les outils eux-mêmes sont dans mapEditor.js.

import { getLineLength } from '/shared/geo.js';
import { formatDistance } from '/shared/instructions.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';
import { createReviewPanel } from '/reviewPanel.js';

const selectElement = (selector) => document.querySelector(selector);
const placeUrl = (placeId) => `/places/${encodeURIComponent(placeId)}`;
const pathUrl = (pathId) => `/paths/${encodeURIComponent(pathId)}`;

export function initCollectMode(context, editor) {
  const { state, showToast } = context;
  let staffSession = null; // { expiresAt, role: 'admin' | 'reviewer', name }

  // Toute réponse 401 met fin au mode collecte : la session a expiré ou a été révoquée.
  async function callStaffApi(method, path, body) {
    try {
      return await callApi(method, path, body);
    } catch (error) {
      if (error.status === 401) {
        if (state.mode === 'collect') editor.close();
        showToast('Session expirée : reconnectez-vous au mode collecte.', 5000);
      }
      throw error;
    }
  }

  async function writeAndReload(method, path, body, message) {
    await callStaffApi(method, path, body);
    await context.reloadCampusMap();
    return message;
  }

  const reviewPanel = createReviewPanel(context, {
    callStaffApi,
    getStaffSession: () => staffSession,
    onRequestClose: () => editor.selectTool(null),
    onCountChange: () => editor.updateToolLabels(),
  });

  function renderNetworkSummary() {
    const campusMap = state.campusMap || { places: [], paths: [] };
    const networkLength = campusMap.paths.reduce((total, path) => total + getLineLength(path.coordinates), 0);
    return html`<p>
      ${campusMap.places.length} lieux · ${campusMap.paths.length} chemins · ${formatDistance(networkLength)} de réseau.
      Choisissez un outil. Le fond satellite aide à repérer toits et allées ; vérifiez toujours sur place.
    </p>`;
  }

  function renderContributionWarnings() {
    const settings = state.campusMap?.settings;
    if (!settings) return '';
    const perimeterHelp =
      staffSession?.role === 'admin'
        ? html`Lancez <code>npm run import-perimeter</code> sur le serveur.`
        : "Prévenez l'administrateur.";
    return html`
      ${
        settings.perimeter
          ? ''
          : html`<p class="warning">
              Périmètre du campus non importé : toute proposition des contributeurs est refusée. ${perimeterHelp}
            </p>`
      }
      ${
        settings.contributionsPaused
          ? html`<p class="warning">Contributions suspendues : les contributeurs ne peuvent rien envoyer.</p>`
          : ''
      }
    `;
  }

  const staffProfile = {
    mode: 'collect',
    get title() {
      return staffSession?.role === 'reviewer'
        ? `MODE COLLECTE · relecteur ${staffSession.name}`
        : 'MODE COLLECTE · administrateur';
    },
    tools: ['place', 'draw', 'walk', 'edit', 'review'],
    canManageExisting: true,
    placeDialogTitle: (placeId) => (placeId ? 'Modifier le lieu' : 'Nouveau lieu'),
    renderIdlePanel: () => html`${renderNetworkSummary()}${renderContributionWarnings()}`,
    onPlaceClick: (place) => editor.openPlaceDialog(place),
    extraTools: {
      review: {
        label: () => `À relire (${reviewPanel.getPendingCount()})`,
        renderPanel: () =>
          html`<p>Propositions, contributeurs et historique s'affichent dans le panneau de relecture.</p>`,
        onSelect: () => {
          reviewPanel.open();
        },
        onDeselect: () => reviewPanel.close(),
      },
    },
    actions: {
      savePlace: (placeBody, placeId) =>
        placeId
          ? writeAndReload('PUT', placeUrl(placeId), placeBody, 'Lieu mis à jour')
          : writeAndReload('POST', '/places', placeBody, 'Lieu ajouté'),
      deletePlace: (placeId) => writeAndReload('DELETE', placeUrl(placeId), undefined, 'Lieu supprimé'),
      savePath: (pathBody) => writeAndReload('POST', '/paths', pathBody, 'Chemin enregistré'),
      updatePath: (pathId, changes) => writeAndReload('PATCH', pathUrl(pathId), changes, 'Chemin mis à jour'),
      deletePath: (pathId) => writeAndReload('DELETE', pathUrl(pathId), undefined, 'Chemin supprimé'),
    },
    onClose: () => {
      reviewPanel.stopCounter();
      reviewPanel.close();
      staffSession = null;
      selectElement('#menu-clear-map').hidden = true;
      selectElement('#menu-logout').hidden = true;
    },
  };

  function enterCollectMode(session) {
    staffSession = session;
    editor.open(staffProfile);
    reviewPanel.startCounter();
    selectElement('#menu-clear-map').hidden = session.role !== 'admin';
    selectElement('#menu-logout').hidden = false;
  }

  // ---------- Connexion ----------

  selectElement('#menu-collect').addEventListener('click', async () => {
    selectElement('#menu-dialog').close();
    if (state.mode === 'collect') return;
    try {
      const { data } = await callApi('GET', '/admin/session');
      enterCollectMode(data);
    } catch {
      selectElement('#login-error').textContent = '';
      selectElement('#login-dialog').showModal();
    }
  });

  selectElement('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tokenInput = selectElement('#token-input');
    try {
      const { data } = await callApi('POST', '/admin/session', { token: tokenInput.value.trim() });
      tokenInput.value = '';
      selectElement('#login-dialog').close();
      enterCollectMode(data);
    } catch (error) {
      selectElement('#login-error').textContent = error.message;
    }
  });

  selectElement('#menu-logout').addEventListener('click', async () => {
    await callApi('DELETE', '/admin/session').catch(() => {});
    selectElement('#menu-dialog').close();
    editor.close();
    showToast('Déconnecté du mode collecte');
  });

  selectElement('#menu-clear-map').addEventListener('click', async () => {
    if (!confirm('Supprimer TOUS les lieux et chemins de la carte ? Cette action est définitive.')) return;
    try {
      await callStaffApi('DELETE', '/campus-map?confirm=true');
      selectElement('#menu-dialog').close();
      await context.reloadCampusMap();
      showToast('Carte vidée : vous pouvez commencer le relevé.');
    } catch (error) {
      showToast(error.message);
    }
  });
}
