#!/usr/bin/env bash
# Vérifie un message de commit : format Conventional Commits et absence de signature
# ou de co-auteur ajoutés automatiquement par un outil.
# Usage : checkCommitMessage.sh <fichier-contenant-le-message>
set -euo pipefail

message_file="$1"
subject="$(head -n 1 "$message_file")"

# Commits de fusion générés par Git : seul le contrôle des traces s'applique.
if [[ "$subject" =~ ^Merge\  ]]; then
  is_merge=1
else
  is_merge=0
fi

forbidden_pattern='co-authored-by|generated (with|by)|🤖|ai-assisted|made with ai|written with ai'
if grep -qiE "$forbidden_pattern" "$message_file"; then
  echo "Commit refusé : le message contient une signature ou un co-auteur ajouté automatiquement par un outil." >&2
  exit 1
fi

if [[ "$is_merge" -eq 1 ]]; then
  exit 0
fi

type_pattern='^(feat|fix|docs|refactor|chore|test|style|perf)(\([a-z0-9-]+\))?!?: [^A-Z].*[^.]$'
if ! [[ "$subject" =~ $type_pattern ]]; then
  echo "Commit refusé : « $subject »" >&2
  echo "Format attendu : type(scope): description en minuscules, sans point final." >&2
  echo "Types : feat, fix, docs, refactor, chore, test, style, perf. Exemple : feat(carte): ajout du mode hors ligne" >&2
  exit 1
fi

if [[ "${#subject}" -gt 72 ]]; then
  echo "Commit refusé : la première ligne dépasse 72 caractères (${#subject})." >&2
  exit 1
fi
