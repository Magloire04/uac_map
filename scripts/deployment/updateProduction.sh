#!/usr/bin/env bash
# Met à jour l'application en production. À lancer en SSH : ~/uac_map/scripts/deployment/updateProduction.sh
# Ordre : sauvegarde, récupération de main, dépendances, migrations, redémarrage. Arrêt à la première erreur.
# Tout le script est dans une fonction : bash le lit en entier avant que git pull ne le remplace.
set -euo pipefail

main() {
  local application_directory="${APPLICATION_DIRECTORY:-$HOME/uac_map}"
  local application_root="${APPLICATION_ROOT:-uac_map}"
  local node_environment="${NODE_ENVIRONMENT_ACTIVATE:-$HOME/nodevenv/uac_map/24/bin/activate}"

  echo "1/5 Sauvegarde de la base"
  "$application_directory/scripts/deployment/backupDatabase.sh"

  echo "2/5 Récupération de main"
  git -C "$application_directory" fetch origin main
  git -C "$application_directory" checkout main
  git -C "$application_directory" pull --ff-only origin main

  echo "3/5 Dépendances (sans les outils de développement)"
  # shellcheck source=/dev/null
  source "$node_environment"
  cd "$application_directory"
  # npm ci supprimerait le lien node_modules créé par CloudLinux : on garde npm install.
  npm install --omit=dev

  echo "4/5 Migrations"
  npm run database:migrate

  echo "5/5 Redémarrage"
  if command -v cloudlinux-selector > /dev/null 2>&1; then
    cloudlinux-selector restart --json --interpreter nodejs --app-root "$application_root"
  else
    mkdir -p "$application_directory/tmp"
    touch "$application_directory/tmp/restart.txt"
  fi
  echo "Mise à jour terminée."
}

main "$@"
