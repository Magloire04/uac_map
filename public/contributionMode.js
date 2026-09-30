/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contribution ouverte : un téléphone présent sur le campus propose des lieux, des corrections et des chemins, sans
// compte. Il rejoint par un lien (?contribuer=code) ; ses propositions sont relues avant publication, sauf s'il est
// « de confiance ». La présence est vérifiée ici avant d'ouvrir les outils, puis par le serveur à chaque envoi :
// seul ce second contrôle fait foi. Les outils eux-mêmes sont dans mapEditor.js.

import { checkDevicePosition, MAX_POSITION_ACCURACY_METERS, MAX_POSITION_AGE_MS } from '/shared/presence.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';

// Drapeau « ce téléphone a rejoint » : il affiche l'entrée du menu même sans lien public. Aucune donnée personnelle,
// l'identité du contributeur reste dans le cookie httpOnly posé par le serveur.
const CONTRIBUTOR_FLAG_KEY = 'uac-map:contributeur';
// Une position reçue il y a moins de 30 secondes part telle quelle ; sinon on en demande une nouvelle.
const FRESH_POSITION_MS = 30 * 1000;
// Repli si la nouvelle lecture échoue : le serveur accepte une position de 2 minutes, on garde 30 secondes pour la requête.
const FALLBACK_POSITION_MS = MAX_POSITION_AGE_MS - 30 * 1000;
const PRESENCE_MESSAGES = {
  WAITING: 'Recherche de votre position… Autorisez la localisation si le téléphone la demande.',
  POSITION_REQUIRED: 'Position indisponible : autorisez la localisation dans les réglages du navigateur.',
  OUTSIDE_CAMPUS:
    'Vous semblez hors du campus : les propositions ne sont possibles que sur place. Rapprochez-vous, ou attendez un meilleur signal.',
  POSITION_INACCURATE: `Signal GPS trop imprécis (${MAX_POSITION_ACCURACY_METERS} m au plus) : sortez à découvert ou patientez.`,
  POSITION_NOT_FOUND: 'Position introuvable pour le moment : faites quelques pas à découvert, puis réessayez.',
  POSITION_TOO_OLD: 'Position trop ancienne : patientez quelques secondes.',
  PERIMETER_NOT_CONFIGURED: "Le périmètre du campus n'est pas encore configuré : les contributions ouvriront bientôt.",
  CONTRIBUTIONS_PAUSED: 'Les contributions sont suspendues pour le moment.',
  CONTRIBUTOR_BLOCKED: 'Ce téléphone ne peut plus proposer de modification.',
};

const selectElement = (selector) => document.querySelector(selector);

function rememberContributor(isContributor) {
  try {
    if (isContributor) localStorage.setItem(CONTRIBUTOR_FLAG_KEY, '1');
    else localStorage.removeItem(CONTRIBUTOR_FLAG_KEY);
  } catch {
    // Stockage indisponible (navigation privée) : l'entrée du menu s'appuiera sur le seul lien public.
  }
}

function isRememberedContributor() {
  try {
    return localStorage.getItem(CONTRIBUTOR_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

const toDevicePosition = (fix) => ({
  longitude: fix.position[0],
  latitude: fix.position[1],
  accuracy: fix.accuracy,
  ageMs: Date.now() - fix.time,
});

const readCurrentPosition = () =>
  new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000,
    });
  });

export function initContributionMode(context, editor) {
  const { state, showToast } = context;
  const joinDialog = selectElement('#join-dialog');
  const joinForm = selectElement('#join-form');
  let contributor = null;
  let publicLinkCode = null;
  let presence = { code: 'WAITING', accuracy: null };
  let selectedPlace = null;

  // ---------- Présence sur le campus ----------

  function evaluatePresence() {
    const settings = state.campusMap?.settings;
    if (contributor?.status === 'blocked') return { code: 'CONTRIBUTOR_BLOCKED', accuracy: null };
    if (!settings?.perimeter) return { code: 'PERIMETER_NOT_CONFIGURED', accuracy: null };
    if (settings.contributionsPaused) return { code: 'CONTRIBUTIONS_PAUSED', accuracy: null };
    const fix = state.gps.lastFix;
    if (!fix) return { code: 'WAITING', accuracy: null };
    return { code: checkDevicePosition(toDevicePosition(fix), settings.perimeter), accuracy: fix.accuracy };
  }

  // Réévaluée à chaque position reçue ; l'éditeur n'est redessiné que si la réponse change, pour ne pas effacer un
  // champ en cours de saisie.
  function updatePresence() {
    const previousCode = presence.code;
    presence = evaluatePresence();
    if (presence.code !== previousCode) editor.render();
  }

  const isOnCampus = () => presence.code === null;

  function describePresence() {
    if (presence.code === 'POSITION_INACCURATE' && presence.accuracy) {
      return `Signal GPS trop imprécis (± ${Math.round(presence.accuracy)} m, ${MAX_POSITION_ACCURACY_METERS} m au plus) : sortez à découvert ou patientez.`;
    }
    return PRESENCE_MESSAGES[presence.code];
  }

  function renderIdlePanel() {
    const pseudonym = contributor.pseudonym ? html`<strong>${contributor.pseudonym}</strong> · ` : '';
    if (!isOnCampus()) return html`<p>${pseudonym}${describePresence()}</p>`;
    const reviewNote =
      contributor.status === 'trusted'
        ? 'vous êtes contributeur de confiance : vos ajouts sont publiés directement.'
        : 'vos propositions sont relues avant publication.';
    return html`<p>
      ${pseudonym}Position vérifiée sur le campus (± ${Math.round(presence.accuracy)} m). Choisissez un outil ;
      ${reviewNote}
    </p>`;
  }

  // ---------- Envoi des propositions ----------

  // Position envoyée avec la proposition : la dernière reçue si elle est récente, sinon une nouvelle lecture.
  async function obtainDevicePosition() {
    const fix = state.gps.lastFix;
    if (fix && Date.now() - fix.time < FRESH_POSITION_MS) return toDevicePosition(fix);
    showToast('Vérification de votre position…');
    try {
      const { coords, timestamp } = await readCurrentPosition();
      return {
        longitude: coords.longitude,
        latitude: coords.latitude,
        accuracy: coords.accuracy,
        ageMs: Date.now() - timestamp,
      };
    } catch (error) {
      const latestFix = state.gps.lastFix;
      if (latestFix && Date.now() - latestFix.time < FALLBACK_POSITION_MS) return toDevicePosition(latestFix);
      // Code 1 : localisation refusée ; codes 2 et 3 : pas de signal pour le moment.
      throw new Error(error?.code === 1 ? PRESENCE_MESSAGES.POSITION_REQUIRED : PRESENCE_MESSAGES.POSITION_NOT_FOUND, {
        cause: error,
      });
    }
  }

  // Suites d'un refus du serveur : téléphone oublié ailleurs, bloqué entre-temps, ou réglages qui ont changé.
  async function handleRefusal(error) {
    if (error.status === 401) {
      rememberContributor(false);
      updateMenuButton();
      editor.close();
    } else if (error.code === 'CONTRIBUTOR_BLOCKED') {
      contributor = { ...contributor, status: 'blocked' };
      presence = evaluatePresence();
    } else if (error.status === 503) {
      await context.reloadCampusMap();
    }
  }

  async function submitProposal(proposal) {
    const devicePosition = await obtainDevicePosition();
    let saved;
    try {
      ({ data: saved } = await callApi('POST', '/proposals', { ...proposal, devicePosition }));
    } catch (error) {
      await handleRefusal(error);
      throw error;
    }
    if (saved.status === 'accepted') {
      await context.reloadCampusMap();
      return 'Merci : votre modification est publiée.';
    }
    return 'Merci : votre proposition sera relue avant publication.';
  }

  // ---------- Fiche d'un lieu en mode contribution ----------

  function openPlaceSheet(place) {
    selectedPlace = place;
    context.openSheet(html`
      ${context.sheetHeader(place.name, 'Proposer une modification de ce lieu')}
      ${isOnCampus() ? '' : html`<p class="hint">${describePresence()}</p>`}
      <div class="actions">
        <button class="button primary" data-action="correct-place" type="button" ${isOnCampus() ? '' : html`disabled`}>
          Corriger ce lieu
        </button>
      </div>
    `);
  }

  const placeSheetActions = {
    'correct-place': () => {
      context.closeSheet();
      editor.openPlaceDialog(selectedPlace);
    },
  };

  const handleSheetAction = (actionName) => placeSheetActions[actionName]?.();

  // ---------- Profil de l'éditeur ----------

  const contributionProfile = {
    mode: 'contribution',
    title: 'CONTRIBUTION',
    tools: ['place', 'draw', 'walk'],
    canManageExisting: false,
    isToolAvailable: isOnCampus,
    placeDialogTitle: (placeId) => (placeId ? 'Proposer une correction' : 'Proposer un lieu'),
    renderIdlePanel,
    onPlaceClick: openPlaceSheet,
    actions: {
      savePlace: (placeBody, placeId) =>
        submitProposal(
          placeId
            ? { entityType: 'place', action: 'update', targetId: placeId, payload: placeBody }
            : { entityType: 'place', action: 'create', payload: placeBody },
        ),
      savePath: (pathBody) => submitProposal({ entityType: 'path', action: 'create', payload: pathBody }),
    },
    onClose: () => {
      state.gps.subscribers.delete(updatePresence);
      state.hooks.onSheetAction = null;
      context.closeSheet();
      context.stopGpsIfUnused();
    },
  };

  function enter(contributorData) {
    contributor = contributorData;
    rememberContributor(true);
    updateMenuButton();
    editor.open(contributionProfile);
    state.hooks.onSheetAction = handleSheetAction;
    state.gps.subscribers.add(updatePresence);
    presence = context.startGps() ? evaluatePresence() : { code: 'POSITION_REQUIRED', accuracy: null };
    editor.render();
  }

  document.addEventListener('campus-map-loaded', () => {
    if (state.mode === 'contribution') updatePresence();
  });

  // ---------- Rejoindre ----------

  function updateMenuButton() {
    selectElement('#menu-contribute').hidden = !publicLinkCode && !isRememberedContributor();
  }

  function openJoinDialog(linkCode) {
    joinDialog.dataset.linkCode = linkCode;
    selectElement('#join-error').textContent = '';
    joinDialog.showModal();
  }

  // Un téléphone déjà inscrit entre directement ; sinon l'écran des règles s'ouvre avec le code du lien.
  async function startFromLink(linkCode) {
    if (state.mode === 'contribution') return;
    try {
      const { data } = await callApi('GET', '/contributors/me');
      enter(data);
    } catch (error) {
      if (error.status !== 401) {
        showToast(error.message, 5000);
        return;
      }
      rememberContributor(false);
      updateMenuButton();
      if (linkCode) openJoinDialog(linkCode);
      else showToast('Ouvrez le lien de contribution que vous avez reçu pour rejoindre.', 5000);
    }
  }

  joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = joinForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const { data } = await callApi('POST', '/contributors', {
        linkCode: joinDialog.dataset.linkCode,
        pseudonym: joinForm.elements.pseudonym.value,
      });
      joinDialog.close();
      joinForm.reset();
      enter(data);
      showToast('Bienvenue ! Votre position va être vérifiée.');
    } catch (error) {
      selectElement('#join-error').textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  selectElement('#menu-contribute').addEventListener('click', () => {
    selectElement('#menu-dialog').close();
    startFromLink(publicLinkCode);
  });

  callApi('GET', '/contribution/public-link')
    .then(({ data }) => {
      publicLinkCode = data.code;
    })
    .catch(() => {
      publicLinkCode = null;
    })
    .finally(updateMenuButton);

  return { startFromLink };
}
