#!/usr/bin/env bash
# Met à jour l'application en production. À lancer en SSH : ~/uac_map/scripts/deployment/updateProduction.sh
# Ordre : sauvegarde, récupération de main, dépendances, migrations, redémarrage. Arrêt à la première erreur,
# avec la marche à suivre pour revenir à la version précédente.
# Tout le script est dans une fonction : bash le lit en entier avant que git pull ne le remplace.
set -Eeuo pipefail

main() {
  local application_directory="${APPLICATION_DIRECTORY:-$HOME/uac_map}"
  local application_root="${APPLICATION_ROOT:-uac_map}"
  local node_environment="${NODE_ENVIRONMENT_ACTIVATE:-$HOME/nodevenv/uac_map/24/bin/activate}"
  local previous_commit
  previous_commit=$(git -C "$application_directory" rev-parse HEAD)
  local current_step=""
  trap 'report_failure "$current_step" "$previous_commit" "$application_directory" "$node_environment"' ERR

  current_step="1/5 Sauvegarde de la base"
  echo "$current_step"
  "$application_directory/scripts/deployment/backupDatabase.sh"

  current_step="2/5 Récupération de main"
  echo "$current_step"
  git -C "$application_directory" fetch origin main
  git -C "$application_directory" checkout main
  git -C "$application_directory" pull --ff-only origin main

  current_step="3/5 Dépendances (sans les outils de développement)"
  echo "$current_step"
  # Le script d'activation de CloudLinux peut lire des variables non définies : set -u est suspendu le temps de le lire.
  set +u
  # shellcheck source=/dev/null
  source "$node_environment"
  set -u
  cd "$application_directory"
  # npm ci supprimerait le lien node_modules créé par CloudLinux : on garde npm install.
  npm install --omit=dev

  current_step="4/5 Migrations"
  echo "$current_step"
  npm run database:migrate

  current_step="5/5 Redémarrage"
  echo "$current_step"
  if command -v cloudlinux-selector > /dev/null 2>&1; then
    cloudlinux-selector restart --json --interpreter nodejs --app-root "$application_root"
  else
    mkdir -p "$application_directory/tmp"
    touch "$application_directory/tmp/restart.txt"
  fi
  trap - ERR
  echo "Mise à jour terminée."
}

# Après un échec, le code, les dépendances et le schéma peuvent ne plus correspondre : l'application risque de
# ne pas redémarrer. On indique comment revenir à la version précédente.
report_failure() {
  local failed_step="$1" previous_commit="$2" application_directory="$3" node_environment="$4"
  trap - ERR
  cat >&2 << MESSAGE

Échec pendant l'étape « $failed_step ».
Pour revenir à la version précédente ($previous_commit) :
  git -C "$application_directory" reset --hard $previous_commit
  source "$node_environment" && cd "$application_directory" && npm install --omit=dev
  puis RESTART dans Setup Node.js App.
Si l'échec est survenu à l'étape 4 ou 5, restaurer aussi la sauvegarde faite à l'étape 1 (docs/deployment.md, section 4).
MESSAGE
}

main "$@"
