/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Éditeur de la carte, partagé par le mode collecte (équipe carto) et la contribution ouverte : barre d'outils,
// tracé et accroche au réseau, enregistrement en marchant, fiche de lieu. Chaque mode ouvre l'éditeur avec son
// profil, qui fixe le titre, les outils proposés et la façon d'enregistrer (écriture directe ou proposition).
//
// Profil :
//   mode               valeur de state.mode : 'collect' ou 'contribution'
//   title              texte de la barre
//   tools              outils affichés, dans l'ordre : place, draw, walk, edit, puis les outils propres du mode
//   extraTools         { [nom]: { label, renderPanel, onSelect?, onDeselect?, onMapClick?, onPlaceClick? } }
//                      (label : texte, ou fonction qui renvoie le texte)
//   commands           { [nom]: async (bouton) => {} } pour les boutons data-command des panneaux propres
//   isToolAvailable    (nom) => booléen ; un outil indisponible est grisé
//   canManageExisting  supprimer un lieu, modifier ou supprimer un chemin, QR code d'un lieu
//   placeDialogTitle   (identifiant du lieu, ou null pour un nouveau lieu) => titre de la fiche
//   renderIdlePanel    () => contenu du panneau quand aucun outil n'est choisi
//   onPlaceClick       (lieu) => {} quand l'outil actif ne gère pas les lieux
//   actions            { savePlace(corps, id), savePath(corps), deletePlace?(id), updatePath?(id, champs),
//                        deletePath?(id) } : chacune enregistre, recharge la carte si besoin et renvoie le message
//                        à afficher
//   onClose            () => {} à la fermeture

import { PLACE_CATEGORIES } from '/shared/search.js';
import { PATH_TYPES, DEFAULT_PATH_TYPE } from '/shared/graph.js';
import { getDistance, simplifyLine, createProjector, projectOnSegment, getLineLength } from '/shared/geo.js';
import { formatDistance } from '/shared/instructions.js';
import { html } from '/safeHtml.js';

const VERTEX_SNAP_PIXELS = 16;
const SEGMENT_SNAP_PIXELS = 12;
const PATH_HIT_PIXELS = 10;
const WALK_MAX_ACCURACY_METERS = 15;
const WALK_MIN_SPACING_METERS = 4;
const WALK_SIMPLIFY_TOLERANCE_METERS = 1.5;
const WALK_ENDPOINT_SNAP_METERS = 8;
const PLACE_TEXT_FIELDS = ['name', 'category', 'aliases', 'description', 'access'];
const TOOL_LABELS = {
  place: 'Ajouter un lieu',
  draw: 'Tracer un chemin',
  walk: 'Enregistrer en marchant',
  edit: 'Modifier',
};

const selectElement = (selector) => document.querySelector(selector);

export function createMapEditor(context) {
  const { map, state, showToast, setSourceData, toFeatureCollection, toLineFeature, toPointFeature } = context;
  let profile = null;
  let activeTool = null;
  let isBusy = false;
  let drawnPoints = [];
  const pathSettings = { type: DEFAULT_PATH_TYPE, isFloodProne: false, name: '' };
  const walkRecording = { isActive: false, points: [], accuracy: null, subscriber: null };
  let placeDraft = null;
  let selectedPath = null;

  const placeDialog = selectElement('#place-dialog');
  const placeForm = selectElement('#place-form');
  const toolList = selectElement('#tool-list');
  const toolPanel = selectElement('#tool-panel');

  placeForm.elements.category.innerHTML = html`${Object.entries(PLACE_CATEGORIES).map(
    ([code, label]) => html`<option value="${code}">${label}</option>`,
  )}`;

  // Un enregistrement à la fois : un second appui pendant l'envoi est ignoré (réseau lent sur le campus).
  async function runExclusive(work) {
    if (isBusy) return;
    isBusy = true;
    try {
      await work();
    } finally {
      isBusy = false;
    }
  }

  // ---------- Ouverture et fermeture ----------

  function open(newProfile) {
    if (profile) close();
    context.resetView();
    profile = newProfile;
    activeTool = null;
    state.mode = profile.mode;
    state.hooks.onMapClick = handleMapClick;
    state.hooks.onPlaceClick = handlePlaceClick;
    selectElement('#top-bar').hidden = true;
    const collectBar = selectElement('#collect-bar');
    collectBar.hidden = false;
    collectBar.dataset.mode = profile.mode;
    context.toggleSatellite(true);
    context.renderEntrances();
    context.renderPerimeter();
    render();
  }

  function close() {
    if (!profile) return;
    stopWalkRecording({ shouldSave: false });
    profile.extraTools?.[activeTool]?.onDeselect?.();
    const closedProfile = profile;
    profile = null;
    activeTool = null;
    drawnPoints = [];
    selectedPath = null;
    placeDraft = null;
    if (placeDialog.open) placeDialog.close();
    state.mode = null;
    state.hooks.onMapClick = null;
    state.hooks.onPlaceClick = null;
    selectElement('#top-bar').hidden = false;
    selectElement('#collect-bar').hidden = true;
    setSourceData('draft', toFeatureCollection([]));
    context.renderEntrances();
    context.renderPerimeter();
    closedProfile.onClose?.();
  }

  // ---------- Barre et panneau ----------

  const readLabel = (toolName) => {
    const label = TOOL_LABELS[toolName] ?? profile.extraTools?.[toolName]?.label;
    return typeof label === 'function' ? label() : label;
  };
  const isToolAvailable = (toolName) => profile.isToolAvailable?.(toolName) ?? true;

  function renderToolList() {
    selectElement('#collect-title').textContent = profile.title;
    toolList.innerHTML = html`${profile.tools.map(
        (toolName) =>
          html`<button
            class="button small${activeTool === toolName ? ' is-active' : ''}"
            data-tool="${toolName}"
            type="button"
            ${isToolAvailable(toolName) ? '' : html`disabled`}
          >
            ${readLabel(toolName)}
          </button>`,
      )} <button class="button small" data-bar-command="quit" type="button">Quitter</button>`;
  }

  function render() {
    if (!profile) return;
    renderToolList();
    renderDraft();
    renderToolPanel();
  }

  toolList.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !profile) return;
    if (button.dataset.barCommand === 'quit') {
      close();
      return;
    }
    const toolName = button.dataset.tool;
    selectTool(activeTool === toolName ? null : toolName);
  });

  function selectTool(toolName) {
    if (!profile) return;
    if (walkRecording.isActive && toolName !== 'walk') {
      if (!confirm("Abandonner l'enregistrement en cours ?")) return;
      stopWalkRecording({ shouldSave: false });
    }
    const previousTool = activeTool;
    activeTool = toolName;
    drawnPoints = [];
    selectedPath = null;
    if (previousTool !== toolName) {
      profile.extraTools?.[previousTool]?.onDeselect?.();
      profile.extraTools?.[toolName]?.onSelect?.();
    }
    render();
  }

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
    none: () => profile.renderIdlePanel(),
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
    const extraTool = profile.extraTools?.[activeTool];
    const content = extraTool ? extraTool.renderPanel() : toolPanelRenderers[activeTool || 'none']();
    toolPanel.innerHTML = html`${content}`;
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
      const message = await profile.actions.savePath({ ...pathSettings, coordinates: drawnPoints });
      drawnPoints = [];
      showToast(message);
    },
    'start-walk': startWalkRecording,
    'cancel-walk': () => stopWalkRecording({ shouldSave: false }),
    'finish-walk': () => stopWalkRecording({ shouldSave: true }),
    'unselect-path': () => {
      selectedPath = null;
    },
    'update-path': async () => {
      const readField = (fieldName) => toolPanel.querySelector(`[data-selected-path="${fieldName}"]`);
      const message = await profile.actions.updatePath(selectedPath.id, {
        type: readField('type').value,
        name: readField('name').value,
        isFloodProne: readField('isFloodProne').checked,
      });
      selectedPath = null;
      showToast(message);
    },
    'delete-path': async () => {
      if (!confirm('Supprimer ce chemin ?')) return;
      const message = await profile.actions.deletePath(selectedPath.id);
      selectedPath = null;
      showToast(message);
    },
  };

  toolPanel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button || !profile) return;
    const command = toolCommands[button.dataset.command] ?? profile.commands?.[button.dataset.command];
    if (!command) return;
    runExclusive(async () => {
      try {
        await command(button);
      } catch (error) {
        showToast(error.message, 5000);
      }
      render();
    });
  });

  // Met à jour le texte des boutons (compteur de la relecture) sans redessiner le panneau : une saisie en cours n'est
  // pas effacée.
  function updateToolLabels() {
    if (!profile) return;
    for (const button of toolList.querySelectorAll('[data-tool]')) button.textContent = readLabel(button.dataset.tool);
  }

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

  // Chemin sous le doigt, dans une zone de quelques pixels autour du point touché.
  function findPathAt(event) {
    const { x, y } = event.point;
    const [feature] = map.queryRenderedFeatures(
      [
        [x - PATH_HIT_PIXELS, y - PATH_HIT_PIXELS],
        [x + PATH_HIT_PIXELS, y + PATH_HIT_PIXELS],
      ],
      { layers: ['paths-hit-area'] },
    );
    return feature ? state.campusMap.paths.find((path) => path.id === feature.properties.id) || null : null;
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
    const message = await profile.actions.savePath({ ...pathSettings, coordinates });
    showToast(`${message} (${coordinates.length} points)`);
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
    selectElement('#place-dialog-title').textContent = profile.placeDialogTitle(placeDraft.id);
    for (const fieldName of PLACE_TEXT_FIELDS) placeForm.elements[fieldName].value = placeDraft[fieldName];
    const canManagePlace = Boolean(profile.canManageExisting && placeDraft.id);
    selectElement('#place-delete').hidden = !canManagePlace;
    const qrCodeLink = selectElement('#qr-code-link');
    qrCodeLink.hidden = !canManagePlace;
    if (canManagePlace) qrCodeLink.href = `/api/v1/places/${encodeURIComponent(placeDraft.id)}/qr-code`;
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

  selectElement('#place-delete').addEventListener('click', () => {
    if (!profile || !placeDraft) return;
    if (!confirm(`Supprimer « ${placeDraft.name} » ?`)) return;
    runExclusive(async () => {
      try {
        const message = await profile.actions.deletePlace(placeDraft.id);
        placeDialog.close();
        discardPlaceDraft();
        showToast(message);
      } catch (error) {
        selectElement('#place-error').textContent = error.message;
      }
    });
  });

  placeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!profile || !placeDraft) return;
    runExclusive(async () => {
      readPlaceForm();
      const { id: placeId, pendingMapClick, ...placeBody } = placeDraft;
      try {
        const message = await profile.actions.savePlace(placeBody, placeId);
        placeDialog.close();
        discardPlaceDraft();
        showToast(message);
        if (activeTool === 'place') selectTool(null);
      } catch (error) {
        selectElement('#place-error').textContent = error.message;
      }
    });
  });

  // ---------- Clics sur la carte ----------

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
    const extraTool = profile.extraTools?.[activeTool];
    if (extraTool) {
      extraTool.onMapClick?.(event, position);
    } else if (activeTool === 'place') {
      openPlaceDialog({ longitude: position[0], latitude: position[1] });
    } else if (activeTool === 'draw') {
      drawnPoints.push(snapToScreenNetwork(event.point, position));
      renderDraft();
      renderToolPanel();
    } else if (activeTool === 'edit') {
      selectedPath = findPathAt(event);
      renderDraft();
      renderToolPanel();
    }
    return true;
  }

  function handlePlaceClick(place) {
    const extraTool = profile.extraTools?.[activeTool];
    if (extraTool?.onPlaceClick) extraTool.onPlaceClick(place);
    else profile.onPlaceClick(place);
  }

  document.addEventListener('campus-map-loaded', () => {
    if (!profile) return;
    if (selectedPath) selectedPath = state.campusMap.paths.find((path) => path.id === selectedPath.id) || null;
    render();
  });

  return {
    open,
    close,
    render,
    selectTool,
    openPlaceDialog,
    findPathAt,
    getActiveTool: () => activeTool,
    updateToolLabels,
  };
}
