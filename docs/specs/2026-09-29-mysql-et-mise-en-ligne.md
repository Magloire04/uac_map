# Passage à MariaDB et mise en ligne

- Statut : proposée, en relecture
- Issue : #10
- Date : 2026-09-29
- Suite prévue : contribution ouverte (projet 2), qui s'appuiera sur cette base

## 1. Contexte

La carte est stockée dans un fichier JSON unique, `data/campus.json`, chargé en mémoire au démarrage. Les écritures sont mises en file dans le processus Node. Les sessions du mode collecte et les compteurs d'échecs de connexion vivent eux aussi en mémoire. Ce fonctionnement suppose un seul processus qui tourne en continu.

L'hébergement retenu ne garantit pas cela. C'est un cPanel mutualisé (CloudLinux, LiteSpeed) qui lance lui-même l'application Node : il peut l'arrêter quand elle est inactive, la redémarrer à tout moment ou en faire tourner plusieurs copies. Chaque redémarrage viderait les sessions, et deux copies qui écrivent dans le même fichier se contrediraient.

Le projet suivant, la contribution ouverte, aura besoin d'un statut et d'un historique par lieu et par chemin, ce qu'un fichier unique ne permet pas.

La décision « Stockage en fichier JSON » de `docs/decisions.md` prévoyait déjà une migration dans ce cas.

## 2. Objectifs

1. Stocker les lieux, les chemins, les réglages de la carte, les sessions du mode collecte et les compteurs d'échecs dans MariaDB, avec un SQL qui reste compatible avec MySQL 8.
2. Garder le contrat de l'API v1 strictement identique : `docs/openapi.yaml` et l'application web ne changent pas.
3. Mettre l'application en ligne sur `https://uacmap.bytechnum.com` depuis la branche `main`, avec une sauvegarde quotidienne de la base et une procédure de mise à jour.

## 3. Hors périmètre

- La contribution ouverte : lien public, file de validation, relecteurs, historique (projet 2).
- Les requêtes spatiales (PostGIS ou équivalent) : les itinéraires restent calculés sur le téléphone.
- Le fond de carte auto-hébergé et les comptes nominatifs.
- La reprise d'un ancien fichier `campus.json` : aucune donnée réelle n'existe dans ce format. Le code du stockage JSON et la conversion du premier prototype sont supprimés.
- Toute modification de l'interface.

## 4. Environnements

| Élément       | Local                                | Production                             | CI                     |
| ------------- | ------------------------------------ | -------------------------------------- | ---------------------- |
| Base          | MariaDB 11.4.9 (WampServer)          | MariaDB 11.4.13 (cPanel)               | Conteneur MariaDB 11.4 |
| Node.js       | 24.15                                | 24.21.0 (Setup Node.js App)            | 24                     |
| Lancement     | `npm start`                          | LiteSpeed, fichier `app.cjs`           | `npm test`             |
| Configuration | `.env` et `.env.test`                | Variables de l'écran Setup Node.js App | Variables du workflow  |
| Données       | Base `uac_map`, tests `uac_map_test` | Base `<compte>_uacmap`                 | Base `uac_map_test`    |

## 5. Modèle de données

Conventions communes à toutes les tables :

- moteur InnoDB, encodage `utf8mb4`, collation `utf8mb4_unicode_ci` (disponible sur MariaDB comme sur MySQL 8) ;
- dates en `DATETIME(3)`, toujours en UTC : la connexion est réglée sur le fuseau `+00:00` ;
- noms de tables et de colonnes en anglais, en `snake_case`. La conversion vers les noms de l'API (`isFloodProne`, `updatedAt`…) se fait en un seul endroit, le module d'accès aux données ;
- colonnes JSON : MariaDB les stocke comme du texte vérifié par `JSON_VALID`. Le module d'accès sérialise et relit ces colonnes lui-même (`JSON.stringify`, `JSON.parse`), pour se comporter de la même façon sur MariaDB et sur MySQL.

Les coordonnées sont en `DOUBLE`, pas en `DECIMAL`, pour relire exactement les nombres écrits par l'application.

### 5.1 `places`

| Colonne       | Type            | Règle                                                                               |
| ------------- | --------------- | ----------------------------------------------------------------------------------- |
| `id`          | `VARCHAR(64)`   | Clé primaire. Formats actuels conservés : `place_xxxxxxxx`, `osm_…`, `demo_place_n` |
| `name`        | `VARCHAR(120)`  | Obligatoire. Index pour le tri                                                      |
| `category`    | `VARCHAR(32)`   | Obligatoire                                                                         |
| `aliases`     | `JSON`          | Tableau de textes, 15 au maximum                                                    |
| `description` | `VARCHAR(1000)` | Texte vide par défaut                                                               |
| `access`      | `VARCHAR(300)`  | Texte vide par défaut                                                               |
| `longitude`   | `DOUBLE`        | Obligatoire                                                                         |
| `latitude`    | `DOUBLE`        | Obligatoire                                                                         |
| `entrances`   | `JSON`          | Tableau de `{ longitude, latitude, note }`, 10 au maximum                           |
| `created_at`  | `DATETIME(3)`   | Heure de création                                                                   |
| `updated_at`  | `DATETIME(3)`   | Heure de la dernière modification                                                   |

### 5.2 `paths`

| Colonne          | Type           | Règle                                                  |
| ---------------- | -------------- | ------------------------------------------------------ |
| `id`             | `VARCHAR(64)`  | Clé primaire. Formats actuels conservés                |
| `type`           | `VARCHAR(32)`  | Obligatoire                                            |
| `name`           | `VARCHAR(120)` | Texte vide par défaut                                  |
| `is_flood_prone` | `BOOLEAN`      | Faux par défaut                                        |
| `coordinates`    | `JSON`         | Tableau de `[longitude, latitude]`, de 2 à 5000 points |
| `created_at`     | `DATETIME(3)`  | Heure de création                                      |
| `updated_at`     | `DATETIME(3)`  | Heure de la dernière modification                      |

### 5.3 `campus_settings`

Une seule ligne, garantie par une contrainte `CHECK (id = 1)`.

| Colonne            | Type           | Règle                                                                          |
| ------------------ | -------------- | ------------------------------------------------------------------------------ |
| `id`               | `TINYINT`      | Clé primaire, toujours 1                                                       |
| `name`             | `VARCHAR(120)` | Nom du campus                                                                  |
| `center_longitude` | `DOUBLE`       | Centre de la carte                                                             |
| `center_latitude`  | `DOUBLE`       | Centre de la carte                                                             |
| `zoom`             | `DOUBLE`       | Zoom initial                                                                   |
| `is_demo`          | `BOOLEAN`      | Vrai quand la carte contient le jeu de démonstration                           |
| `updated_at`       | `DATETIME(3)`  | Mis à jour dans la même transaction que toute écriture sur `places` ou `paths` |

### 5.4 `admin_sessions`

| Colonne             | Type          | Règle                                                                                                  |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `session_digest`    | `BINARY(32)`  | Clé primaire : empreinte SHA-256 de l'identifiant contenu dans le cookie                               |
| `token_fingerprint` | `BINARY(32)`  | Empreinte SHA-256 de l'`ADMIN_TOKEN` en vigueur à l'ouverture, précédé d'un préfixe propre à cet usage |
| `expires_at`        | `DATETIME(3)` | Fin de validité, 12 heures après l'ouverture. Indexée pour la purge                                    |
| `created_at`        | `DATETIME(3)` | Heure d'ouverture                                                                                      |

### 5.5 `failed_login_attempts`

| Colonne         | Type           | Règle                                                                                    |
| --------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `client_digest` | `BINARY(32)`   | Clé primaire : HMAC-SHA-256 de l'adresse du client, avec une clé dérivée d'`ADMIN_TOKEN` |
| `failure_count` | `INT UNSIGNED` | Nombre d'échecs dans la fenêtre en cours                                                 |
| `reset_at`      | `DATETIME(3)`  | Fin de la fenêtre de 15 minutes                                                          |

### 5.6 `schema_migrations`

| Colonne      | Type           | Règle                                      |
| ------------ | -------------- | ------------------------------------------ |
| `version`    | `VARCHAR(100)` | Clé primaire : nom du fichier de migration |
| `applied_at` | `DATETIME(3)`  | Heure d'application                        |

### 5.7 Correspondance avec l'API

`GET /api/v1/campus-map` renvoie toujours `{ version: 2, settings: { name, center: [longitude, latitude], zoom, isDemo, updatedAt }, places, paths }`, avec les mêmes champs pour chaque lieu et chaque chemin. L'application web n'utilise que `settings.isDemo`, `settings.center` et `settings.zoom`, qui gardent leur forme.

Le tri et la pagination des listes se font en SQL. `sort-by` n'accepte que `id` ou `name`, comme aujourd'hui : une table de correspondance traduit cette valeur en nom de colonne, et aucun nom de colonne ne vient directement de la requête. L'identifiant sert d'ordre secondaire, pour qu'une page donne toujours le même résultat. La collation `utf8mb4_unicode_ci` ignore la casse et les accents, comme le tri actuel.

## 6. Accès à la base

- Pilote `mysql2`, avec un pool de 5 connexions au maximum. Les hébergements mutualisés limitent le nombre de connexions par utilisateur.
- Requêtes préparées pour toutes les valeurs. Les requêtes multiples dans un même appel (`multipleStatements`) restent désactivées pour l'application. Seule la commande de migration les active, sur une connexion qui lui est propre.
- Modules prévus dans `server/database/` :
  - `connection.js` : création du pool, fuseau UTC, fermeture propre ;
  - `migrations.js` : lecture et application des fichiers de migration ;
  - `campusMapRepository.js` : lieux, chemins, réglages, transactions ;
  - `adminSessionRepository.js` : sessions du mode collecte ;
  - `failedLoginAttemptRepository.js` : compteurs d'échecs.
- Aucun cache en mémoire : chaque requête lit la base, puisque plusieurs copies de l'application peuvent tourner en même temps.
- Les écritures qui touchent plusieurs lignes (vider la carte, charger la démonstration, importer OpenStreetMap) se font dans une transaction : tout est appliqué, ou rien.
- Une collision d'identifiant est refusée par la clé primaire. Le serveur génère alors un nouvel identifiant et réessaie une fois.
- Une erreur de base pendant une requête produit la réponse 500 générique habituelle. Le détail va dans les journaux du serveur, sans les paramètres de connexion.

## 7. Sessions et limites

- Le cookie `uac_admin_session` ne change pas : `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS, chemin `/api`, durée de 12 heures. L'accès par en-tête `Authorization: Bearer` pour les scripts reste possible.
- La base ne contient que l'empreinte de l'identifiant de session. Une copie de la base ne permet donc pas d'ouvrir une session.
- Une session n'est valide que si elle n'a pas expiré et si son `token_fingerprint` correspond au jeton actuel. Changer `ADMIN_TOKEN` ferme donc toutes les sessions ouvertes, y compris celles d'une personne qui aurait obtenu l'ancien jeton.
- La déconnexion supprime la ligne. Les sessions expirées sont effacées à chaque ouverture de session.
- Le blocage reste fixé à 10 échecs par client sur 15 minutes, partagé entre toutes les copies de l'application. L'incrément est atomique (`INSERT … ON DUPLICATE KEY UPDATE`).
- L'adresse du client n'est jamais écrite en clair : on stocke seulement son empreinte HMAC, et la ligne disparaît à la fin de sa fenêtre. Le journal de sécurité ne change pas : pas de jeton, pas d'adresse IP, pas de donnée personnelle.

## 8. Configuration

| Variable                      | Obligatoire   | Défaut          | Rôle                                                                                                              |
| ----------------------------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_HOST`               | Non           | `localhost`     | Serveur MariaDB                                                                                                   |
| `DATABASE_PORT`               | Non           | `3306`          | Port MariaDB                                                                                                      |
| `DATABASE_NAME`               | Oui           |                 | Base de l'application                                                                                             |
| `DATABASE_USER`               | Oui           |                 | Utilisateur MariaDB, avec des droits sur cette base uniquement                                                    |
| `DATABASE_PASSWORD`           | En production | Vide            | Mot de passe. Il peut rester vide en local avec l'utilisateur par défaut de WampServer                            |
| `ADMIN_TOKEN`                 | En production |                 | Jeton du mode collecte, 18 caractères au minimum. En local, `data/.admin-token` est généré comme aujourd'hui      |
| `TRUST_PROXY`                 | Non           | `loopback`      | Réglage `trust proxy` d'Express : `true`, `false`, un nombre de proxys, ou des adresses séparées par des virgules |
| `NODE_ENV`                    | En production |                 | `production` en ligne, fixé par le mode « Production » de Setup Node.js App                                       |
| `PUBLIC_URL`                  | En production | Vide            | `https://uacmap.bytechnum.com`, encodée dans les QR codes                                                         |
| `PORT`                        | Non           | `3000`          | Inchangé                                                                                                          |
| `HTTPS_ENABLED`, `HTTPS_PORT` | Non           | `false`, `3443` | Inchangés, pour les tests sur téléphone en local uniquement                                                       |
| `OVERPASS_URL`                | Non           | overpass-api.de | Inchangé                                                                                                          |

En production, ces variables sont écrites dans un fichier `.env` à la racine de l'application (droits `600`, hors de `public_html`). Le serveur le lit au démarrage sans écraser une variable déjà définie, et les commandes lancées en SSH (`npm run database:migrate`…) le lisent aussi. L'écran Setup Node.js App ne sert qu'à choisir le mode Production.

`DATA_FILE` disparaît. Le dossier `data/` ne garde que `.admin-token` (local), `cert/` (HTTPS local) et `osm-brut.json` (réponse brute d'OpenStreetMap).

Le serveur refuse de démarrer, avec un message clair qui ne contient aucun secret, dans trois cas : une variable obligatoire manque, la base est injoignable, ou le schéma est en retard sur les migrations présentes dans le code.

Un fichier `app.cjs` à la racine charge `server/index.js`. Il sert de fichier de démarrage sur l'hébergement, au cas où celui-ci charge l'application avec `require()`, ce qui ne fonctionne pas directement avec des modules ES. `npm start` ne change pas.

## 9. Migrations et commandes

### 9.1 Migrations du schéma

- Chaque changement de structure est un fichier `server/database/migrations/NNN-description.sql`. Le premier, `001-initial-schema.sql`, crée les tables de la section 5.
- `npm run database:migrate` applique, dans l'ordre, les fichiers absents de `schema_migrations`, puis les y inscrit.
- Un verrou MariaDB (`GET_LOCK('uac_map_migrations', 30)`) empêche deux lancements simultanés.
- MariaDB valide automatiquement les créations de tables, sans retour arrière possible. Chaque fichier est donc écrit pour pouvoir être relancé sans casse (`CREATE TABLE IF NOT EXISTS`…). En cas d'échec, la commande s'arrête en nommant le fichier en cause.

### 9.2 Commandes de maintenance

| Commande                   | Comportement                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `npm run database:migrate` | Nouvelle. Applique les migrations manquantes                                        |
| `npm run demo`             | Charge la démonstration. Refuse d'écraser des données réelles, sauf avec `--forcer` |
| `npm run reset -- --oui`   | Vide les lieux et les chemins                                                       |
| `npm run import-osm`       | Importe depuis OpenStreetMap. Options `--fichier` et `--remplacer` conservées       |

Chaque commande qui écrit le fait dans une transaction. Le message « Redémarrez le serveur » disparaît, puisque le serveur lit la base à chaque requête.

### 9.3 Premier lancement

Si la ligne de `campus_settings` n'existe pas encore :

- hors production, le serveur charge la démonstration, comme aujourd'hui ;
- en production, il crée les réglages par défaut et laisse la carte vide. La démonstration n'est jamais chargée automatiquement.

Cette initialisation est protégée par un verrou (`GET_LOCK('uac_map_initialisation', 30)`), pour que deux copies qui démarrent en même temps ne la fassent pas deux fois.

### 9.4 Code retiré

- `server/store.js` (stockage JSON et conversion du premier prototype) et ses tests `tests/store.test.js`, remplacés par le module d'accès et ses tests.
- `scripts/dataFilePath.js`, remplacé par un simple chemin vers `data/` pour `osm-brut.json`.

## 10. Tests

- Les tests purement logiques (géométrie, graphe, recherche, consignes, validation, conversion OpenStreetMap, journal de sécurité) ne changent pas.
- Les tests du module d'accès, des sessions, des limites, des migrations, des commandes et de l'API tournent sur une vraie base MariaDB.
- Leur configuration est lue dans `.env.test`, non versionné, décrit par un modèle `.env.test.example`.
- Garde-fou : ces tests vident les tables. Ils refusent de s'exécuter si le nom de la base ne se termine pas par `_test`.
- Ils partagent une base, donc les fichiers de test s'exécutent les uns après les autres (`--test-concurrency=1`).
- Sans base de test configurée, ces tests sont ignorés en local avec un avertissement visible. Dans la CI (variable `CI` définie), l'absence de base fait échouer la suite.
- Les tests actuels de l'API, dont celui qui vérifie que chaque route du contrat OpenAPI existe, doivent passer sans modification de leurs attentes. C'est la preuve que le contrat n'a pas bougé.

Nouveaux tests, écrits avant le code correspondant :

| Sujet            | Ce qui est vérifié                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lieux et chemins | Création, lecture, remplacement, suppression. Identifiants conservés. Accents, sigles et entrées identiques après un aller-retour                                                  |
| Pagination       | Tri par `id` et par `name`, dans les deux sens. Valeur de `sort-by` hors liste refusée                                                                                             |
| Transactions     | Une remise à zéro, un chargement de démonstration ou un import qui échoue en cours de route ne laisse rien à moitié écrit                                                          |
| Sessions         | Seule l'empreinte est stockée. Expiration après 12 heures. Déconnexion. Fermeture de toutes les sessions quand `ADMIN_TOKEN` change                                                |
| Limites          | Compteur partagé entre deux instances de l'application. Remise à zéro après 15 minutes. Aucune adresse en clair                                                                    |
| Migrations       | Seules les migrations manquantes sont appliquées. Une seconde exécution ne change rien. Deux lancements simultanés ne se gênent pas                                                |
| Démarrage        | Refus si une variable obligatoire manque ou si le schéma est en retard. Pas de démonstration automatique en production. `TRUST_PROXY` pris en compte. `app.cjs` démarre le serveur |

## 11. CI

- Le job `lint-et-tests` démarre un service `mariadb:11.4` avec un contrôle de santé, crée la base `uac_map_test` et passe à Node 24, la version de production.
- Les noms des jobs `lint-et-tests` et `commits` ne changent pas : la protection de `main` et `develop` continue de les exiger sans réglage supplémentaire.

## 12. Déploiement

### 12.1 Installation initiale

Toutes les étapes sont décrites pas à pas dans `docs/deployment.md`.

| Étape           | Outil cPanel             | Détail                                                                                                                                              |
| --------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Base         | Database Wizard          | Base `<compte>_uacmap`, utilisateur du même nom, mot de passe fort, droits sur cette base uniquement                                                |
| 2. Code         | Git Version Control      | Clone de `https://github.com/Magloire04/uac_map.git` dans `/home/<compte>/uac_map`, hors de `public_html`, branche `main`                           |
| 3. Application  | Setup Node.js App        | Node 24.21.0, mode Production, racine `uac_map`, URL `uacmap.bytechnum.com`, fichier de démarrage `app.cjs` ; configuration dans `.env` (section 8) |
| 4. Dépendances  | Setup Node.js App ou SSH | Installation sans les outils de développement (`npm install --omit=dev` dans l'environnement de l'application)                                      |
| 5. Schéma       | SSH                      | `npm run database:migrate`                                                                                                                          |
| 6. Identifiants | SSH                      | Fichier dédié `~/.uac_map.my.cnf` (utilisateur et mot de passe de la base), droits `600`, pour les sauvegardes                                      |
| 7. Sauvegardes  | Tâches Cron              | Sauvegarde quotidienne à 3 h (section 12.4)                                                                                                         |

CloudLinux range les dépendances dans l'environnement de l'application et relie `node_modules` à cet emplacement. Il ne faut donc pas créer de dossier `node_modules` à la main dans `/home/<compte>/uac_map`.

### 12.2 Publication d'une version

Les PR du projet sont fusionnées dans `develop`. Une branche `release/AAAA-MM-JJ` est ensuite ouverte depuis `develop`, fusionnée dans `main` par PR, puis étiquetée (`v0.2.0` pour ce projet). Seule `main` est déployée.

### 12.3 Mise à jour

`scripts/deployment/updateProduction.sh`, lancé en SSH, enchaîne :

1. une sauvegarde de la base (section 12.4), et s'arrête si elle échoue ;
2. la récupération de `main` (`git pull --ff-only`) ;
3. l'installation des dépendances sans les outils de développement ;
4. les migrations ;
5. le redémarrage de l'application, avec la commande de CloudLinux à confirmer sur l'hébergement.

### 12.4 Sauvegardes

- `scripts/deployment/backupDatabase.sh` exporte la base avec `mysqldump --single-transaction`, compresse l'export, le date (`uac_map-AAAAMMJJ-HHMM.sql.gz`), le range dans `~/backups/uac_map/` et efface les exports de plus de 14 jours.
- Le mot de passe est lu dans `~/.uac_map.my.cnf`, un fichier dédié qui ne touche pas au `~/.my.cnf` éventuel du compte. Il n'apparaît ni dans le script, ni dans la tâche cron, ni dans les journaux.
- Le script tourne tous les jours à 3 h, et avant chaque mise à jour.
- La restauration (décompression puis import avec `mysql`) est décrite dans `docs/deployment.md`. Elle est testée une fois après la mise en ligne, en réimportant un export dans le MariaDB de WampServer.
- Limite : les exports restent sur le même serveur. Un export est téléchargé chaque semaine, ou une sauvegarde externe de l'hébergeur est activée.

## 13. Critères d'acceptation

1. `npm run check` passe en local avec MariaDB, et la CI est verte.
2. Tous les tests actuels de l'API passent sans modification de leurs attentes.
3. `https://uacmap.bytechnum.com/api/v1/health` répond 200.
4. La page d'accueil s'affiche en HTTPS sur téléphone, et le GPS fonctionne.
5. Le cookie de session du mode collecte porte l'attribut `Secure`.
6. Dix jetons faux envoyés depuis un téléphone en 4G bloquent ce téléphone, pendant qu'un ordinateur en Wi-Fi peut toujours se connecter.
7. Un lieu créé en mode collecte est toujours présent après un redémarrage de l'application depuis cPanel, et la session reste ouverte.
8. Le QR code d'un lieu contient `https://uacmap.bytechnum.com/?ici=<identifiant>`.
9. La sauvegarde quotidienne produit un export, et cet export se réimporte dans WampServer.
10. `docs/deployment.md` permet de refaire l'installation sans autre information.

## 14. Risques et points à vérifier sur l'hébergement

| Risque                                                             | Parade                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| L'hébergement charge l'application avec `require()`                | Fichier de démarrage `app.cjs`                                                |
| `TRUST_PROXY` mal réglé : adresse du client ou HTTPS mal détectés  | Critères 5 et 6, puis ajustement de la variable                               |
| `uacmap.bytechnum.com` absent de la liste « URL de l'application » | Déclarer le sous-domaine dans l'hébergement Spaceship avant l'étape 3         |
| Nombre de connexions limité par utilisateur MariaDB                | Pool de 5 connexions                                                          |
| Commande de redémarrage propre à CloudLinux                        | Vérifiée à la première installation, puis inscrite dans `updateProduction.sh` |
| Exports conservés sur le même serveur                              | Téléchargement hebdomadaire ou sauvegarde externe                             |
| Autres sites de production sur le même compte                      | Base et utilisateur dédiés, sans droit sur les autres bases                   |

## 15. Documentation à mettre à jour

- `README.md` : démarrage avec WampServer (création des bases `uac_map` et `uac_map_test`, fichiers `.env` et `.env.test`), commandes, architecture, limites connues.
- `.env.example` : nouvelles variables, retrait de `DATA_FILE`. Nouveau modèle `.env.test.example`.
- `CONTRIBUTING.md` : les tests d'intégration exigent MariaDB.
- `docs/decisions.md` : nouvelle décision « MariaDB plutôt que PostgreSQL », et décision « Stockage en fichier JSON » marquée comme remplacée.
- `docs/deployment.md` : nouveau.
- `docs/openapi.yaml` et `SECURITY.md` : inchangés.

## 16. Décisions prises pendant la conception

| Sujet                 | Décision                                             | Raison                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moteur                | MariaDB, SQL compatible MySQL 8                      | Fourni et administré par l'hébergement, identique à WampServer. PostgreSQL et SQLite écartés : le premier demanderait un serveur à administrer, le second supporte mal plusieurs copies de l'application |
| Structure             | Tables classiques avec colonnes JSON pour les listes | Lecture et écriture par lieu ou par chemin, et le projet 2 ajoute ses colonnes sans restructuration                                                                                                      |
| Données existantes    | Aucune reprise de fichier JSON                       | Pas de données réelles dans ce format                                                                                                                                                                    |
| Node.js en production | 24.21.0                                              | Version la plus récente proposée, alignée sur le poste de développement                                                                                                                                  |
| Découpage             | Ce projet d'abord, contribution ouverte ensuite      | Mise en ligne rapide pour l'équipe de relevé, sur une base prête pour le projet 2                                                                                                                        |
