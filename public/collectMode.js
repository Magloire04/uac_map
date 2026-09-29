/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mode collecte : relevé des lieux, entrées et chemins sur le terrain (équipe carto, session protégée).

import { PLACE_CATEGORIES } from '/shared/search.js';
import { PATH_TYPES, DEFAULT_PATH_TYPE } from '/shared/graph.js';
import { getDistance, simplifyLine, createProjector, projectOnSegment, getLineLength } from '/shared/geo.js';
import { formatDistance } from '/shared/instructions.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';

const VERTEX_SNAP_PIXELS = 16;
const SEGMENT_SNAP_PIXELS = 12;
const WALK_MAX_ACCURACY_METERS = 15;
const WALK_MIN_SPACING_METERS = 4;
const WALK_SIMPLIFY_TOLERANCE_METERS = 1.5;
const WALK_ENDPOINT_SNAP_METERS = 8;
const PLACE_TEXT_FIELDS = ['name', 'category', 'aliases', 'description', 'access'];

const selectElement = (selector) => document.querySelector(selector);

export function initCollectMode(context) {
  const { map, state, showToast, setSourceData, toFeatureCollection, toLineFeature, toPointFeature } = context;
  let activeTool = null;
  let drawnPoints = [];
  const pathSettings = { type: DEFAULT_PATH_TYPE, isFloodProne: false, name: '' };
  const walkRecording = { isActive: false, points: [], accuracy: null, subscriber: null };
  let placeDraft = null;
  let selectedPath = null;

  const placeDialog = selectElement('#place-dialog');
  const placeForm = selectElement('#place-form');
  const toolPanel = selectElement('#tool-panel');

  placeForm.elements.category.innerHTML = html`${Object.entries(PLACE_CATEGORIES).map(
    ([code, label]) => html`<option value="${code}">${label}</option>`,
  )}`;

  // Toute réponse 401 met fin au mode collecte : la session a expiré ou a été révoquée.
  async function callAdminApi(method, path, body) {
    try {
      return await callApi(method, path, body);
    } catch (error) {
      if (error.status === 401) {
        exitCollectMode();
        showToast('Session expirée : reconnectez-vous au mode collecte.', 5000);
      }
      throw error;
    }
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
    exitCollectMode();
    showToast('Déconnecté du mode collecte');
  });

  function enterCollectMode() {
    context.resetView();
    state.mode = 'collect';
    state.hooks.onMapClick = handleMapClick;
    state.hooks.onPlaceClick = (place) => openPlaceDialog(place);
    selectElement('#top-bar').hidden = true;
    selectElement('#collect-bar').hidden = false;
    selectElement('#menu-clear-map').hidden = false;
    selectElement('#menu-logout').hidden = false;
    context.toggleSatellite(true);
    context.renderEntrances();
    selectTool(null);
  }

  function exitCollectMode() {
    stopWalkRecording({ shouldSave: false });
    drawnPoints = [];
    selectedPath = null;
    activeTool = null;
    state.mode = null;
    state.hooks.onMapClick = null;
    state.hooks.onPlaceClick = null;
    selectElement('#top-bar').hidden = false;
    selectElement('#collect-bar').hidden = true;
    selectElement('#menu-clear-map').hidden = true;
    selectElement('#menu-logout').hidden = true;
    setSourceData('draft', toFeatureCollection([]));
    context.renderEntrances();
  }

  selectElement('#collect-quit').addEventListener('click', exitCollectMode);

  selectElement('#menu-clear-map').addEventListener('click', async () => {
    if (!confirm('Supprimer TOUS les lieux et chemins de la carte ? Cette action est définitive.')) return;
    try {
      await callAdminApi('DELETE', '/campus-map?confirm=true');
      selectElement('#menu-dialog').close();
      await context.reloadCampusMap();
      showToast('Carte vidée : vous pouvez commencer le relevé.');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.querySelectorAll('[data-tool]').forEach((toolButton) => {
    toolButton.addEventListener('click', () =>
      selectTool(activeTool === toolButton.dataset.tool ? null : toolButton.dataset.tool),
    );
  });

  function selectTool(toolName) {
    if (walkRecording.isActive && toolName !== 'walk') {
      if (!confirm("Abandonner l'enregistrement en cours ?")) return;
      stopWalkRecording({ shouldSave: false });
    }
    activeTool = toolName;
    drawnPoints = [];
    selectedPath = null;
    document.querySelectorAll('[data-tool]').forEach((toolButton) => {
      toolButton.classList.toggle('is-active', toolButton.dataset.tool === toolName);
    });
    renderDraft();
    renderToolPanel();
  }

  // ---------- Panneau d'outil ----------

  const pathTypeOptions = (selectedType) =>
    Object.entries(PATH_TYPES).map(
      ([code, label]) => html`<option value="${code}" ${selectedType === code ? html`selected` : ''}>${label}</option>`,
    );

  const pathSettingsFields = () => html`
    <div class="row">
      <select data-path-setting="type" aria-label="Type de chemin">
        ${pathTypeOptions(pathSettings.type)}
      </select>
      <input
        type="text"
        data-path-setting="name"
        placeholder="Nom (facultatif)"
        value="${pathSettings.name}"
        maxlength="120"
      />
      <label
        ><input type="checkbox" data-path-setting="isFloodProne" ${pathSettings.isFloodProne ? html`checked` : ''} />
        Inondable en saison des pluies</label
      >
    </div>
  `;

  const toolPanelRenderers = {
    none: () => {
      const campusMap = state.campusMap || { places: [], paths: [] };
      const networkLength = campusMap.paths.reduce((total, path) => total + getLineLength(path.coordinates), 0);
      return html`<p>
        ${campusMap.places.length} lieux · ${campusMap.paths.length} chemins · ${formatDistance(networkLength)} de
        réseau. Choisissez un outil. Le fond satellite aide à repérer toits et allées ; vérifiez toujours sur place.
      </p>`;
    },
    place: () => html`<p>Touchez la carte au centre du bâtiment. Vous placerez ensuite ses portes d'entrée.</p>`,
    draw: () => html`
      <p>
        Touchez la carte pour poser les points du chemin. Près d'un chemin existant, le point s'y accroche : c'est ce
        qui relie le réseau.
      </p>
      ${pathSettingsFields()}
      <div class="row">
        <strong
          >${drawnPoints.length}
          point${drawnPoints.length > 1 ? 's' : ''}${
            drawnPoints.length > 1 ? ` · ${formatDistance(getLineLength(drawnPoints))}` : ''
          }</strong
        >
        <button
          class="button small"
          data-command="remove-last-point"
          type="button"
          ${drawnPoints.length ? '' : html`disabled`}
        >
          Retirer le dernier
        </button>
        <button
          class="button small primary"
          data-command="save-drawn-path"
          type="button"
          ${drawnPoints.length > 1 ? '' : html`disabled`}
        >
          Enregistrer
        </button>
        <button
          class="button small"
          data-command="clear-drawn-path"
          type="button"
          ${drawnPoints.length ? '' : html`disabled`}
        >
          Effacer
        </button>
      </div>
    `,
    walk: () =>
      walkRecording.isActive
        ? html`
            <p>
              Marchez au milieu du chemin. Seuls les relevés à ± ${WALK_MAX_ACCURACY_METERS} m ou mieux sont gardés.
            </p>
            <div class="row">
              <strong
                >GPS ± ${walkRecording.accuracy ? Math.round(walkRecording.accuracy) : '…'} m ·
                ${walkRecording.points.length} points · ${formatDistance(getLineLength(walkRecording.points))}</strong
              >
            </div>
            <div class="row">
              <button
                class="button small primary"
                data-command="finish-walk"
                type="button"
                ${walkRecording.points.length > 1 ? '' : html`disabled`}
              >
                Terminer et enregistrer
              </button>
              <button class="button small" data-command="cancel-walk" type="button">Abandonner</button>
            </div>
          `
        : html`
            <p>
              Enregistre le chemin en suivant votre GPS. Pratique pour les sentiers invisibles sur l'image satellite,
              mais moins précis qu'un tracé à la main.
            </p>
            ${pathSettingsFields()}
            <div class="row">
              <button class="button small primary" data-command="start-walk" type="button">
                Démarrer l'enregistrement
              </button>
            </div>
          `,
    edit: () =>
      selectedPath
        ? html`
            <p>Chemin sélectionné (${formatDistance(getLineLength(selectedPath.coordinates))}).</p>
            <div class="row">
              <select data-selected-path="type" aria-label="Type de chemin">
                ${pathTypeOptions(selectedPath.type)}
              </select>
              <input
                type="text"
                data-selected-path="name"
                value="${selectedPath.name}"
                placeholder="Nom"
                maxlength="120"
              />
              <label
                ><input
                  type="checkbox"
                  data-selected-path="isFloodProne"
                  ${selectedPath.isFloodProne ? html`checked` : ''}
                />
                Inondable</label
              >
            </div>
            <div class="row">
              <button class="button small primary" data-command="update-path" type="button">Enregistrer</button>
              <button class="button small danger" data-command="delete-path" type="button">Supprimer le chemin</button>
              <button class="button small" data-command="unselect-path" type="button">Désélectionner</button>
            </div>
          `
        : html`<p>Touchez un lieu pour modifier sa fiche, ou un chemin pour changer son type ou le supprimer.</p>`,
  };

  function renderToolPanel() {
    toolPanel.innerHTML = html`${toolPanelRenderers[activeTool || 'none']()}`;
  }

  const readPathSetting = (element) => (element.type === 'checkbox' ? element.checked : element.value);
  toolPanel.addEventListener('change', (event) => {
    const settingName = event.target.dataset.pathSetting;
    if (settingName) pathSettings[settingName] = readPathSetting(event.target);
  });
  toolPanel.addEventListener('input', (event) => {
    if (event.target.dataset.pathSetting === 'name') pathSettings.name = event.target.value;
  });

  const toolCommands = {
    'remove-last-point': () => drawnPoints.pop(),
    'clear-drawn-path': () => {
      drawnPoints = [];
    },
    'save-drawn-path': async () => {
      await callAdminApi('POST', '/paths', { ...pathSettings, coordinates: drawnPoints });
      drawnPoints = [];
      await context.reloadCampusMap();
      showToast('Chemin enregistré');
    },
    'start-walk': startWalkRecording,
    'cancel-walk': () => stopWalkRecording({ shouldSave: false }),
    'finish-walk': () => stopWalkRecording({ shouldSave: true }),
    'unselect-path': () => {
      selectedPath = null;
    },
    'update-path': async () => {
      const readField = (fieldName) => toolPanel.querySelector(`[data-selected-path="${fieldName}"]`);
      await callAdminApi('PATCH', `/paths/${encodeURIComponent(selectedPath.id)}`, {
        type: readField('type').value,
        name: readField('name').value,
        isFloodProne: readField('isFloodProne').checked,
      });
      selectedPath = null;
      await context.reloadCampusMap();
      showToast('Chemin mis à jour');
    },
    'delete-path': async () => {
      if (!confirm('Supprimer ce chemin ?')) return;
      await callAdminApi('DELETE', `/paths/${encodeURIComponent(selectedPath.id)}`);
      selectedPath = null;
      await context.reloadCampusMap();
      showToast('Chemin supprimé');
    },
  };

  toolPanel.addEventListener('click', async (event) => {
    const commandName = event.target.closest('[data-command]')?.dataset.command;
    if (!commandName) return;
    try {
      await toolCommands[commandName]?.();
    } catch (error) {
      showToast(error.message, 5000);
    }
    renderDraft();
    renderToolPanel();
  });

  // ---------- Brouillon affiché sur la carte ----------

  function renderDraft() {
    const features = [];
    const points = activeTool === 'walk' ? walkRecording.points : drawnPoints;
    if (points.length > 1) features.push(toLineFeature(points));
    for (const point of points) features.push(toPointFeature(point));
    if (selectedPath) features.push(toLineFeature(selectedPath.coordinates));
    if (placeDraft) {
      features.push(toPointFeature([placeDraft.longitude, placeDraft.latitude]));
      for (const entrance of placeDraft.entrances)
        features.push(toPointFeature([entrance.longitude, entrance.latitude]));
    }
    setSourceData('draft', toFeatureCollection(features));
  }

  // Accroche un point touché au sommet ou au segment de chemin le plus proche (distance à l'écran).
  function snapToScreenNetwork(screenPoint, position) {
    const vertices = [...state.campusMap.paths.flatMap((path) => path.coordinates), ...drawnPoints];
    let closest = null;
    for (const vertex of vertices) {
      const projected = map.project(vertex);
      const distance = Math.hypot(projected.x - screenPoint.x, projected.y - screenPoint.y);
      if (distance < VERTEX_SNAP_PIXELS && (!closest || distance < closest.distance))
        closest = { distance, position: vertex };
    }
    if (closest) return closest.position;
    for (const path of state.campusMap.paths) {
      for (let index = 1; index < path.coordinates.length; index++) {
        const start = map.project(path.coordinates[index - 1]);
        const end = map.project(path.coordinates[index]);
        const projection = projectOnSegment([screenPoint.x, screenPoint.y], [start.x, start.y], [end.x, end.y]);
        if (projection.distance < SEGMENT_SNAP_PIXELS && (!closest || projection.distance < closest.distance)) {
          const snapped = map.unproject(projection.point);
          closest = { distance: projection.distance, position: [snapped.lng, snapped.lat] };
        }
      }
    }
    return closest ? closest.position : position;
  }

  // Même principe en mètres, pour raccorder les extrémités d'une trace GPS au réseau existant.
  function snapToNearbyNetwork(position, radiusMeters = WALK_ENDPOINT_SNAP_METERS) {
    const projector = createProjector(position[1]);
    const planePosition = projector.toPlane(position);
    let closest = null;
    for (const path of state.campusMap.paths) {
      for (let index = 0; index < path.coordinates.length; index++) {
        const vertexDistance = getDistance(position, path.coordinates[index]);
        if (vertexDistance <= radiusMeters && (!closest || vertexDistance < closest.distance - 2)) {
          closest = { distance: vertexDistance, position: path.coordinates[index] };
        }
        if (index === 0) continue;
        const projection = projectOnSegment(
          planePosition,
          projector.toPlane(path.coordinates[index - 1]),
          projector.toPlane(path.coordinates[index]),
        );
        if (projection.distance <= radiusMeters && (!closest || projection.distance < closest.distance)) {
          closest = { distance: projection.distance, position: projector.toLonLat(projection.point) };
        }
      }
    }
    return closest ? closest.position : position;
  }

  // ---------- Enregistrement en marchant ----------

  function startWalkRecording() {
    if (!context.startGps()) return;
    Object.assign(walkRecording, { isActive: true, points: [], accuracy: null });
    walkRecording.subscriber = (fix) => {
      walkRecording.accuracy = fix.accuracy;
      if (fix.accuracy <= WALK_MAX_ACCURACY_METERS) {
        const lastPoint = walkRecording.points[walkRecording.points.length - 1];
        if (!lastPoint || getDistance(lastPoint, fix.position) >= WALK_MIN_SPACING_METERS) {
          walkRecording.points.push(fix.position);
        }
      }
      renderDraft();
      renderToolPanel();
    };
    state.gps.subscribers.add(walkRecording.subscriber);
  }

  async function stopWalkRecording({ shouldSave }) {
    if (!walkRecording.isActive) return;
    state.gps.subscribers.delete(walkRecording.subscriber);
    walkRecording.isActive = false;
    context.stopGpsIfUnused();
    const recordedPoints = walkRecording.points;
    walkRecording.points = [];
    if (!shouldSave) return;
    const coordinates = simplifyLine(recordedPoints, WALK_SIMPLIFY_TOLERANCE_METERS);
    if (coordinates.length < 2 || getLineLength(coordinates) < 3) {
      showToast("Trace trop courte, rien n'a été enregistré");
      return;
    }
    coordinates[0] = snapToNearbyNetwork(coordinates[0]);
    coordinates[coordinates.length - 1] = snapToNearbyNetwork(coordinates[coordinates.length - 1]);
    await callAdminApi('POST', '/paths', { ...pathSettings, coordinates });
    await context.reloadCampusMap();
    showToast(`Chemin enregistré (${coordinates.length} points)`);
  }

  // ---------- Fiche d'un lieu ----------

  function openPlaceDialog(place) {
    placeDraft = {
      id: place.id || null,
      name: place.name || '',
      category: place.category || 'other',
      aliases: (place.aliases || []).join(', '),
      description: place.description || '',
      access: place.access || '',
      longitude: place.longitude,
      latitude: place.latitude,
      entrances: (place.entrances || []).map((entrance) => ({ ...entrance })),
      pendingMapClick: null,
    };
    fillPlaceForm();
    placeDialog.showModal();
  }

  function fillPlaceForm() {
    selectElement('#place-dialog-title').textContent = placeDraft.id ? 'Modifier le lieu' : 'Nouveau lieu';
    for (const fieldName of PLACE_TEXT_FIELDS) placeForm.elements[fieldName].value = placeDraft[fieldName];
    selectElement('#place-delete').hidden = !placeDraft.id;
    const qrCodeLink = selectElement('#qr-code-link');
    qrCodeLink.hidden = !placeDraft.id;
    if (placeDraft.id) qrCodeLink.href = `/api/v1/places/${encodeURIComponent(placeDraft.id)}/qr-code`;
    selectElement('#place-error').textContent = '';
    const entranceItems = placeDraft.entrances.length
      ? html`${placeDraft.entrances.map(
          (entrance, index) =>
            html`<li>
              <span>${index + 1}.</span>
              <input
                data-entrance-note="${index}"
                value="${entrance.note}"
                placeholder="Ex. porte côté parking, 1er étage à gauche"
                maxlength="120"
              />
              <button
                class="button small danger"
                type="button"
                data-remove-entrance="${index}"
                aria-label="Retirer l'entrée ${index + 1}"
              >
                Retirer
              </button>
            </li>`,
        )}`
      : html`<li class="note">Aucune entrée placée : le trajet mènera au centre du bâtiment.</li>`;
    selectElement('#entrance-editor').innerHTML = html`${entranceItems}`;
    renderDraft();
  }

  function readPlaceForm() {
    for (const fieldName of PLACE_TEXT_FIELDS) placeDraft[fieldName] = placeForm.elements[fieldName].value;
    document.querySelectorAll('#entrance-editor [data-entrance-note]').forEach((noteInput) => {
      placeDraft.entrances[Number(noteInput.dataset.entranceNote)].note = noteInput.value;
    });
  }

  selectElement('#entrance-editor').addEventListener('click', (event) => {
    const entranceIndex = event.target.dataset.removeEntrance;
    if (entranceIndex === undefined) return;
    readPlaceForm();
    placeDraft.entrances.splice(Number(entranceIndex), 1);
    fillPlaceForm();
  });

  function waitForMapClick(purpose, message) {
    readPlaceForm();
    placeDraft.pendingMapClick = purpose;
    placeDialog.close();
    showToast(message, 6000);
  }

  selectElement('#add-entrance').addEventListener('click', () =>
    waitForMapClick('entrance', "Touchez la porte d'entrée sur la carte"),
  );
  selectElement('#move-place').addEventListener('click', () =>
    waitForMapClick('move', 'Touchez le nouvel emplacement du lieu'),
  );

  const discardPlaceDraft = () => {
    placeDraft = null;
    renderDraft();
  };
  selectElement('#place-cancel').addEventListener('click', () => {
    placeDialog.close();
    discardPlaceDraft();
  });
  placeDialog.addEventListener('cancel', discardPlaceDraft);

  selectElement('#place-delete').addEventListener('click', async () => {
    if (!confirm(`Supprimer « ${placeDraft.name} » ?`)) return;
    try {
      await callAdminApi('DELETE', `/places/${encodeURIComponent(placeDraft.id)}`);
      placeDialog.close();
      discardPlaceDraft();
      await context.reloadCampusMap();
      showToast('Lieu supprimé');
    } catch (error) {
      selectElement('#place-error').textContent = error.message;
    }
  });

  placeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    readPlaceForm();
    const { id: placeId, pendingMapClick, ...placeBody } = placeDraft;
    try {
      if (placeId) await callAdminApi('PUT', `/places/${encodeURIComponent(placeId)}`, placeBody);
      else await callAdminApi('POST', '/places', placeBody);
      placeDialog.close();
      discardPlaceDraft();
      await context.reloadCampusMap();
      showToast(placeId ? 'Lieu mis à jour' : 'Lieu ajouté');
      if (activeTool === 'place') selectTool(null);
    } catch (error) {
      selectElement('#place-error').textContent = error.message;
    }
  });

  // ---------- Clics sur la carte en mode collecte ----------

  function handleMapClick(event, position) {
    if (placeDraft?.pendingMapClick) {
      const [longitude, latitude] = position;
      if (placeDraft.pendingMapClick === 'entrance') placeDraft.entrances.push({ longitude, latitude, note: '' });
      else Object.assign(placeDraft, { longitude, latitude });
      placeDraft.pendingMapClick = null;
      fillPlaceForm();
      placeDialog.showModal();
      return true;
    }
    if (activeTool === 'place') {
      openPlaceDialog({ longitude: position[0], latitude: position[1] });
    } else if (activeTool === 'draw') {
      drawnPoints.push(snapToScreenNetwork(event.point, position));
      renderDraft();
      renderToolPanel();
    } else if (activeTool === 'edit') {
      const { x, y } = event.point;
      const [feature] = map.queryRenderedFeatures(
        [
          [x - 10, y - 10],
          [x + 10, y + 10],
        ],
        { layers: ['paths-hit-area'] },
      );
      selectedPath = feature ? state.campusMap.paths.find((path) => path.id === feature.properties.id) || null : null;
      renderDraft();
      renderToolPanel();
    }
    return true;
  }

  document.addEventListener('campus-map-loaded', () => {
    if (state.mode !== 'collect') return;
    if (selectedPath) selectedPath = state.campusMap.paths.find((path) => path.id === selectedPath.id) || null;
    renderToolPanel();
  });
}
