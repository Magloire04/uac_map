#!/usr/bin/env bash
# Sauvegarde la base de production : export cohérent, compressé, daté, conservé 14 jours.
# Identifiants lus dans un fichier dédié (droits 600) : aucun mot de passe dans ce script ni dans la tâche cron.
# Variables facultatives : DATABASE_NAME, DATABASE_CREDENTIALS_FILE, BACKUP_DIRECTORY, BACKUP_RETENTION_DAYS.
set -euo pipefail

database_name="${DATABASE_NAME:-${USER}_uacmap}"
credentials_file="${DATABASE_CREDENTIALS_FILE:-$HOME/.uac_map.my.cnf}"
backup_directory="${BACKUP_DIRECTORY:-$HOME/backups/uac_map}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"

if [ ! -r "$credentials_file" ]; then
  echo "Fichier d'identifiants introuvable : $credentials_file" >&2
  exit 1
fi

mkdir -p "$backup_directory"
chmod 700 "$backup_directory"
backup_file="$backup_directory/uac_map-$(date -u +%Y%m%d-%H%M).sql.gz"
temporary_file="$backup_file.partiel"
trap 'rm -f "$temporary_file"' ERR

mysqldump --defaults-file="$credentials_file" --single-transaction --quick --no-tablespaces "$database_name" \
  | gzip > "$temporary_file"
mv "$temporary_file" "$backup_file"
chmod 600 "$backup_file"
find "$backup_directory" -name 'uac_map-*.sql.gz' -type f -mtime +"$retention_days" -delete
echo "Sauvegarde : $backup_file"
