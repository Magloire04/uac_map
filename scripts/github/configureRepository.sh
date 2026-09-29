#!/usr/bin/env bash
# Configure le dépôt GitHub selon CONTRIBUTING.md : branche par défaut, fusion, protection de main et develop.
# Prérequis : GitHub CLI (https://cli.github.com) connecté avec un compte administrateur du dépôt (gh auth login).
# Usage : scripts/github/configureRepository.sh [propriétaire/dépôt]
set -euo pipefail

repository="${1:-Magloire04/uac_map}"
required_checks='["lint-et-tests","commits"]'

echo "Réglages généraux de $repository…"
gh api --method PATCH "repos/$repository" --silent --input - <<JSON
{
  "description": "Carte et guidage piéton du campus de l'Université d'Abomey-Calavi",
  "default_branch": "develop",
  "has_issues": true,
  "has_wiki": false,
  "has_projects": false,
  "allow_merge_commit": true,
  "allow_squash_merge": false,
  "allow_rebase_merge": false,
  "delete_branch_on_merge": true,
  "allow_update_branch": true
}
JSON

gh api --method PUT "repos/$repository/topics" --silent --input - <<JSON
{ "names": ["benin", "abomey-calavi", "university-campus", "wayfinding", "pwa", "maplibre", "openstreetmap", "nodejs"] }
JSON

echo "Signalement privé des vulnérabilités…"
gh api --method PUT "repos/$repository/private-vulnerability-reporting" --silent

# Protection identique sur main et develop : PR obligatoire, CI verte et à jour, ni poussée forcée
# ni suppression de la branche. Approbations requises : 0 tant que le projet a un seul développeur
# (voir docs/decisions.md), à passer à 1 dès l'arrivée d'un deuxième contributeur.
for branch in main develop; do
  echo "Protection de $branch…"
  gh api --method PUT "repos/$repository/branches/$branch/protection" --silent --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $required_checks },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
done

echo "Terminé. Vérification : https://github.com/$repository/settings/branches"
