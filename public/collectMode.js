/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mode collecte : relevé des lieux, entrées et chemins par l'équipe carto (session protégée). Ses écritures sont
// publiées directement ; les outils eux-mêmes sont dans mapEditor.js.

import { getLineLength } from '/shared/geo.js';
import { formatDistance } from '/shared/instructions.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';

const selectElement = (selector) => document.querySelector(selector);
const placeUrl = (placeId) => `/places/${encodeURIComponent(placeId)}`;
const pathUrl = (pathId) => `/paths/${encodeURIComponent(pathId)}`;

export function initCollectMode(context, editor) {
  const { state, showToast } = context;

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

  function renderNetworkSummary() {
    const campusMap = state.campusMap || { places: [], paths: [] };
    const networkLength = campusMap.paths.reduce((total, path) => total + getLineLength(path.coordinates), 0);
    return html`<p>
      ${campusMap.places.length} lieux · ${campusMap.paths.length} chemins · ${formatDistance(networkLength)} de réseau.
      Choisissez un outil. Le fond satellite aide à repérer toits et allées ; vérifiez toujours sur place.
    </p>`;
  }

  const staffProfile = {
    mode: 'collect',
    title: 'MODE COLLECTE',
    tools: ['place', 'draw', 'walk', 'edit'],
    canManageExisting: true,
    placeDialogTitle: (placeId) => (placeId ? 'Modifier le lieu' : 'Nouveau lieu'),
    renderIdlePanel: renderNetworkSummary,
    onPlaceClick: (place) => editor.openPlaceDialog(place),
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
      selectElement('#menu-clear-map').hidden = true;
      selectElement('#menu-logout').hidden = true;
    },
  };

  function enterCollectMode() {
    editor.open(staffProfile);
    selectElement('#menu-clear-map').hidden = false;
    selectElement('#menu-logout').hidden = false;
  }

  // ---------- Connexion ----------

  selectElement('#menu-collect').addEventListener('click', async () => {
    selectElement('#menu-dialog').close();
    if (state.mode === 'collect') return;
    try {
      await callApi('GET', '/admin/session');
      enterCollectMode();
    } catch {
      selectElement('#login-error').textContent = '';
      selectElement('#login-dialog').showModal();
    }
  });

  selectElement('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tokenInput = selectElement('#token-input');
    try {
      await callApi('POST', '/admin/session', { token: tokenInput.value.trim() });
      tokenInput.value = '';
      selectElement('#login-dialog').close();
      enterCollectMode();
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
