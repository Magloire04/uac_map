# Contribution ouverte

- Statut : proposée, en relecture
- Issue : #20
- Date : 2026-09-30
- S'appuie sur : [2026-09-29-mysql-et-mise-en-ligne.md](2026-09-29-mysql-et-mise-en-ligne.md) (MariaDB, version 0.2.0 en ligne)

## 1. Intention

Aujourd'hui, seul le détenteur du jeton unique peut relever la carte, et ce jeton donne tous les droits, y compris celui de vider la carte. Le relevé du campus demande beaucoup de monde sur le terrain.

Ce projet permet à n'importe quelle personne présente sur le campus de proposer des lieux, des corrections et des chemins, sans créer de compte, tout en gardant fiable la carte que voient les visiteurs :

- les propositions d'un nouveau contributeur passent par une file de validation tenue par des relecteurs nommés ;
- un contributeur qui a fait ses preuves peut être promu « de confiance » et publier directement ;
- chaque modification publiée entre dans un historique qui permet de l'annuler ;
- l'administrateur garde la main sur les relecteurs, les liens de contribution et un interrupteur de suspension.

## 2. Décisions de conception

| Sujet                               | Décision                                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication                         | Mixte : validation obligatoire pour un contributeur « nouveau », publication directe pour un contributeur « de confiance »                                                                                       |
| Accès des contributeurs             | Sans compte. Un lien public et son QR code, affichés sur le site, que l'administrateur peut fermer ou remplacer. Chaque téléphone reçoit un identifiant dans un cookie, avec un pseudo facultatif                |
| Ce qu'un contributeur peut proposer | Création de lieu, correction de lieu, création de chemin (tracé ou enregistré en marchant), signalement d'erreur sur un lieu ou un chemin. Aucune suppression, aucune modification du tracé d'un chemin existant |
| Relecteurs                          | Accès personnels créés par l'administrateur, jeton affiché une seule fois, révocables un par un. L'administrateur garde `ADMIN_TOKEN`                                                                            |
| Stockage des propositions           | Table séparée : la carte publique et ses tables ne voient jamais une proposition non validée                                                                                                                     |
| Présence sur le campus              | Obligatoire pour les contributeurs : position GPS récente et précise dans le périmètre, et tout ce qui est tracé dans le périmètre. L'administrateur et les relecteurs en sont exemptés                          |
| Protections                         | File de validation, limites d'envoi par téléphone et par connexion, blocage d'un téléphone (qui refuse tout ce qu'il a en attente), suspension des contributions. Pas de captcha dans ce projet                  |

## 3. Hors périmètre

- Comptes nominatifs pour les contributeurs.
- Notifications par e-mail aux relecteurs.
- Modification du tracé d'un chemin existant par un contributeur : il le signale, un relecteur corrige.
- Édition du périmètre dans l'interface : il vient d'OpenStreetMap et se réimporte.
- Captcha, application mobile native, plans d'intérieur.

## 4. Modèle de données

Nouvelle migration `server/database/migrations/002-contribution-ouverte.sql`, relançable comme la première. Conventions inchangées : InnoDB, `utf8mb4_unicode_ci`, dates `DATETIME(3)` en UTC calculées côté JavaScript, colonnes en anglais `snake_case`, JSON relu par le module d'accès. Les tables `places` et `paths` ne changent pas.

### 4.1 `contribution_links`

| Colonne      | Type          | Règle                                                                                                      |
| ------------ | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`         | `VARCHAR(32)` | Clé primaire : code aléatoire (16 octets en base64url), placé dans l'URL `?contribuer=<id>`                |
| `label`      | `VARCHAR(80)` | Nom donné par l'administrateur (« Lien public du site », « Promo L2 géographie »)                          |
| `is_active`  | `BOOLEAN`     | Un lien fermé n'accepte plus de nouveaux contributeurs                                                     |
| `is_public`  | `BOOLEAN`     | Le lien affiché sur le site. Au plus un lien actif est public : en désigner un retire le statut aux autres |
| `created_at` | `DATETIME(3)` |                                                                                                            |
| `closed_at`  | `DATETIME(3)` | Vide tant que le lien est actif                                                                            |

Le code d'un lien n'est pas un secret : il est affiché sur le site. Fermer un lien empêche seulement de nouveaux téléphones de rejoindre par lui ; les contributeurs déjà inscrits gardent leur statut.

### 4.2 `contributors`

| Colonne         | Type          | Règle                                                                                                                   |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`            | `VARCHAR(36)` | Clé primaire (UUID)                                                                                                     |
| `device_digest` | `BINARY(32)`  | Unique : empreinte SHA-256 du secret contenu dans le cookie                                                             |
| `link_id`       | `VARCHAR(32)` | Lien par lequel le téléphone a rejoint (clé étrangère, suppression refusée tant que des contributeurs y sont rattachés) |
| `pseudonym`     | `VARCHAR(40)` | Facultatif, visible des relecteurs seulement                                                                            |
| `status`        | `VARCHAR(16)` | `new`, `trusted` ou `blocked`                                                                                           |
| `created_at`    | `DATETIME(3)` |                                                                                                                         |
| `last_seen_at`  | `DATETIME(3)` | Mis à jour à chaque appel authentifié, sert à la purge                                                                  |

### 4.3 `reviewers`

| Colonne        | Type          | Règle                                                                               |
| -------------- | ------------- | ----------------------------------------------------------------------------------- |
| `id`           | `VARCHAR(36)` | Clé primaire (UUID)                                                                 |
| `name`         | `VARCHAR(80)` | Nom affiché dans l'historique                                                       |
| `token_digest` | `BINARY(32)`  | Unique : empreinte SHA-256 du jeton personnel, affiché une seule fois à la création |
| `is_active`    | `BOOLEAN`     | Faux après révocation                                                               |
| `created_at`   | `DATETIME(3)` |                                                                                     |
| `revoked_at`   | `DATETIME(3)` | Vide tant que le relecteur est actif                                                |

### 4.4 `proposals`

| Colonne                    | Type           | Règle                                                                                                      |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                       | `VARCHAR(36)`  | Clé primaire (UUID)                                                                                        |
| `contributor_id`           | `VARCHAR(36)`  | Clé étrangère vers `contributors`, remise à vide si le contributeur est supprimé                           |
| `entity_type`              | `VARCHAR(8)`   | `place` ou `path`                                                                                          |
| `action`                   | `VARCHAR(8)`   | `create`, `update` (lieux seulement) ou `report`                                                           |
| `target_id`                | `VARCHAR(64)`  | Lieu ou chemin visé par une correction ou un signalement, vide pour une création                           |
| `target_updated_at`        | `DATETIME(3)`  | Version de la cible au moment de l'envoi, pour détecter un conflit                                         |
| `payload`                  | `JSON`         | Lieu ou chemin validé par `cleanPlace` ou `cleanPath`, ou `{ message }` pour un signalement                |
| `position_accuracy_meters` | `DOUBLE`       | Précision de la position vérifiée. Les coordonnées ne sont jamais stockées                                 |
| `status`                   | `VARCHAR(12)`  | `pending`, `accepted`, `rejected` ou `withdrawn`                                                           |
| `reviewer_kind`            | `VARCHAR(8)`   | `admin` ou `reviewer`, vide tant que la proposition n'est pas traitée ou si elle a été publiée directement |
| `reviewer_id`              | `VARCHAR(36)`  | Relecteur qui a traité la proposition                                                                      |
| `review_note`              | `VARCHAR(300)` | Note facultative, montrée au contributeur                                                                  |
| `created_at`               | `DATETIME(3)`  |                                                                                                            |
| `reviewed_at`              | `DATETIME(3)`  |                                                                                                            |

Index : `(status, created_at)` pour la file, `(contributor_id)` pour « Mes propositions ».

### 4.5 `map_changes`

| Colonne             | Type                             | Règle                                                                  |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `id`                | `BIGINT UNSIGNED AUTO_INCREMENT` | Clé primaire, ordre chronologique                                      |
| `entity_type`       | `VARCHAR(8)`                     | `place`, `path` ou `map` (opération en masse)                          |
| `entity_id`         | `VARCHAR(64)`                    | Vide pour une opération en masse                                       |
| `action`            | `VARCHAR(8)`                     | `create`, `update`, `delete`, `revert` ou `bulk`                       |
| `before_state`      | `JSON`                           | Version précédente, vide pour une création                             |
| `after_state`       | `JSON`                           | Nouvelle version, vide pour une suppression                            |
| `actor_kind`        | `VARCHAR(12)`                    | `admin`, `reviewer`, `contributor` ou `command`                        |
| `actor_id`          | `VARCHAR(36)`                    | Relecteur ou contributeur, vide pour l'administrateur et les commandes |
| `proposal_id`       | `VARCHAR(36)`                    | Proposition d'origine, remise à vide si elle disparaît                 |
| `reverts_change_id` | `BIGINT UNSIGNED`                | Modification annulée par celle-ci                                      |
| `created_at`        | `DATETIME(3)`                    |                                                                        |

Index : `(entity_type, entity_id)` et `(created_at)`.

Chaque écriture unitaire sur un lieu ou un chemin (API, proposition acceptée, publication directe, annulation) inscrit sa ligne dans la même transaction que la modification. Les opérations en masse (`demo`, `reset`, `import-osm`, vider la carte) inscrivent une seule ligne `bulk`, sans état, qui ne s'annule pas.

### 4.6 `rate_limits`

| Colonne          | Type           | Règle                                                                            |
| ---------------- | -------------- | -------------------------------------------------------------------------------- |
| `limit_kind`     | `VARCHAR(32)`  | Nature de la limite (section 8)                                                  |
| `subject_digest` | `BINARY(32)`   | Empreinte du sujet : identifiant de contributeur, ou HMAC de l'adresse du client |
| `attempt_count`  | `INT UNSIGNED` | Nombre d'actions dans la fenêtre                                                 |
| `reset_at`       | `DATETIME(3)`  | Fin de la fenêtre                                                                |

Clé primaire `(limit_kind, subject_digest)`, index `(reset_at)`. La réservation est atomique, sur le modèle de `reserveLoginAttempt` ; les lignes expirées sont effacées à chaque réservation. `failed_login_attempts` reste en place.

### 4.7 Tables existantes complétées

- `campus_settings` : `perimeter` (`JSON`, polygone `[[longitude, latitude], …]`, vide tant qu'il n'est pas importé) et `contributions_paused` (`BOOLEAN`, faux par défaut).
- `admin_sessions` : `actor_kind` (`VARCHAR(12)`, `admin` par défaut) et `reviewer_id` (`VARCHAR(36)`, clé étrangère vers `reviewers`, suppression en cascade). Une session de relecteur n'est valide que si le relecteur est actif ; son `token_fingerprint` est dérivé de son jeton personnel.

## 5. Présence sur le campus

### 5.1 Périmètre

- Source : le contour de l'université dans OpenStreetMap (`UAC_BOUNDARY_WAY_ID` de `server/openStreetMapImport.js`).
- Nouvelle commande `npm run import-perimeter` : télécharge ce contour par Overpass (ou le lit avec `--fichier`), le valide (polygone fermé d'au moins 4 points) et l'enregistre dans `campus_settings.perimeter`, sans toucher aux lieux ni aux chemins. Elle inscrit une ligne `bulk` dans l'historique.
- `GET /campus-map` expose `settings.perimeter` et `settings.contributionsPaused`. Le mode collecte de l'administrateur et des relecteurs trace le périmètre sur la carte.
- Sans périmètre enregistré, toute proposition est refusée (`503 PERIMETER_NOT_CONFIGURED`), et le mode collecte de l'administrateur affiche un avertissement.

### 5.2 Règle

| Contrôle                                                                                       | Constante                      | Valeur            |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ----------------- |
| Position du téléphone dans le périmètre, marge comprise                                        | `PERIMETER_MARGIN_METERS`      | 50 m              |
| Précision annoncée par le téléphone                                                            | `MAX_POSITION_ACCURACY_METERS` | 50 m au plus      |
| Âge de la position, mesuré par l'horloge du téléphone (`ageMs`)                                | `MAX_POSITION_AGE_MS`          | 2 minutes au plus |
| Géométrie proposée (lieu, entrées, chaque point d'un chemin) dans le périmètre, marge comprise | `PERIMETER_MARGIN_METERS`      | 50 m              |

- La fonction `isInsidePerimeter(position, perimeter, marginMeters)` rejoint `shared/geo.js` : même calcul dans le navigateur et sur le serveur (point dans le polygone, ou à moins de la marge d'un de ses côtés, en projection locale).
- L'application vérifie la position avant d'ouvrir les outils du contributeur ; le serveur la revérifie à chaque envoi, et seul ce contrôle fait foi.
- On peut rejoindre depuis n'importe où ; on ne peut proposer que sur place.
- Limite assumée : un navigateur permet de simuler une position. La règle arrête l'usage à distance et les abus ordinaires ; la file de validation, les limites et le blocage traitent le reste.

## 6. Parcours du contributeur

1. Le menu du site affiche « Contribuer à la carte » quand un lien public actif existe. Le même lien, en QR code, peut être imprimé.
2. À la première ouverture de `?contribuer=<code>`, un écran présente les règles (être sur le campus, aucune donnée personnelle dans les propositions, relecture avant publication), ce qui est conservé et combien de temps, et propose un pseudo facultatif. Valider crée le contributeur et dépose le cookie.
3. L'application demande la position. Les outils s'ouvrent si la règle de la section 5 est respectée ; sinon, un message l'explique et invite à se rapprocher ou à attendre un meilleur signal.
4. Outils : « Ajouter un lieu », « Corriger ce lieu » (depuis la fiche d'un lieu), « Tracer un chemin », « Enregistrer en marchant », « Signaler une erreur » (lieu ou chemin). Ils reprennent le tracé, l'accroche au réseau et le formulaire de lieu du mode collecte actuel.
5. Chaque envoi transmet la position du moment. Contributeur « nouveau » : la proposition part en file (« Merci, votre proposition sera relue »). Contributeur « de confiance » : elle est publiée et inscrite à l'historique.
6. « Mes propositions » liste ce que le téléphone a envoyé, avec son état et la note éventuelle du relecteur. Les propositions en attente s'affichent en pointillés sur la carte de ce téléphone uniquement.
7. « Oublier ce téléphone » supprime le contributeur, retire ses propositions en attente et efface le cookie ; ce qui a été publié reste, attribué à « contributeur supprimé ».

Cookie `uac_contributor` : secret aléatoire de 32 octets, `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS, chemin `/api`, 180 jours.

## 7. Relecture et administration

- Le relecteur se connecte au mode collecte avec son jeton personnel, sur le même écran que l'administrateur. `POST /admin/session` reconnaît le type de jeton et ouvre une session `admin` ou `reviewer`.
- L'administrateur et les relecteurs gardent les outils actuels du mode collecte, sans règle de présence ; leurs écritures entrent dans l'historique avec leur identité.
- Panneau « Propositions à relire », avec un compteur dans la barre du mode collecte : de la plus ancienne à la plus récente, filtre par type ; aperçu sur la carte dans une couleur à part ; avant et après champ par champ pour une correction ; message et élément mis en évidence pour un signalement ; pseudo, statut, bilan du contributeur et précision de la position vérifiée ; avertissement de conflit si la cible a changé depuis l'envoi.
- Actions : accepter (publie et inscrit à l'historique), refuser avec une note facultative, marquer un signalement comme traité, bloquer le téléphone (refuse tout ce qu'il a en attente), accorder ou retirer la confiance, annuler une modification depuis l'historique.
- Annuler une modification remet son `before_state` ; c'est refusé (`409 CHANGE_OUTDATED`) si l'élément a été modifié depuis, auquel cas on annule d'abord la modification la plus récente. Une ligne `bulk` ne s'annule pas.
- Réservé à l'administrateur : relecteurs (créer, révoquer), liens (créer, fermer, désigner le lien public), suspension des contributions, vider la carte. Une session de relecteur reçoit `403` sur ces routes.

## 8. Protections

### 8.1 Limites d'envoi

| `limit_kind`                 | Sujet                       | Valeur                               |
| ---------------------------- | --------------------------- | ------------------------------------ |
| `proposal_per_contributor`   | Contributeur                | 30 par heure                         |
| `contributor_per_connection` | HMAC de l'adresse du client | 100 nouveaux contributeurs par heure |
| `proposal_per_connection`    | HMAC de l'adresse du client | 500 propositions par heure           |

Les limites par connexion sont volontairement larges : sur le Wi-Fi du campus comme en 4G, de nombreux étudiants partagent la même adresse publique. La limite qui compte est celle par téléphone ; celle par connexion n'est qu'un plafond contre un robot. Un dépassement répond `429 TOO_MANY_REQUESTS`.

### 8.2 Sécurité

- Matrice de droits vérifiée sur chaque route (anonyme, contributeur, relecteur, administrateur) et couverte par des tests.
- Cookies `SameSite=Strict`, API en JSON uniquement, aucun en-tête CORS : un autre site ne peut pas agir au nom d'un contributeur ou d'un relecteur.
- Longueurs contrôlées par le serveur : pseudo 40 caractères, signalement 500, note de relecture 300, libellé de lien 80, nom de relecteur 80. Tout texte est affiché par le gabarit `html` qui échappe les valeurs.
- Jetons de relecteur et secrets de cookie aléatoires (32 octets), stockés sous forme d'empreinte.
- Nouveaux événements du journal de sécurité, sans pseudo ni adresse IP : `contributor_joined`, `contributor_forgotten`, `proposal_submitted`, `proposal_published_directly`, `proposal_accepted`, `proposal_rejected`, `contributor_status_changed`, `reviewer_created`, `reviewer_revoked`, `contribution_link_created`, `contribution_link_updated`, `contributions_paused`, `contributions_resumed`, `map_change_reverted`, `perimeter_imported`.

### 8.3 Données personnelles (APDP)

- Collecté : identifiant aléatoire par téléphone, pseudo facultatif, contenu des propositions, précision de la position vérifiée, HMAC de l'adresse du client dans `rate_limits` (effacé à la fin de chaque fenêtre). Jamais de coordonnées GPS de contributeur.
- Information donnée sur l'écran de règles (section 6, étape 2).
- Suppression à la demande : « Oublier ce téléphone » (`DELETE /contributors/me`).
- Conservation : `npm run purge-contributors`, lancée chaque mois par cron, supprime les contributeurs inactifs depuis 12 mois (`CONTRIBUTOR_RETENTION_MONTHS`), avec les mêmes effets que « Oublier ce téléphone ».

## 9. API

Toutes les routes sont sous `/api/v1`, avec l'enveloppe `{ data, meta }` et `{ error: { code, message, status } }`, la pagination habituelle sur les listes, et sont décrites dans `docs/openapi.yaml` avant d'être codées.

### 9.1 Public et contributeur

| Route                            | Accès        | Rôle                                                                                                                             | Erreurs propres                                                                                                                                                                                                                                       |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /contribution/public-link`  | Public       | Lien public actif (`{ code, url }`)                                                                                              | `404 NO_PUBLIC_LINK`                                                                                                                                                                                                                                  |
| `POST /contributors`             | Public       | Rejoindre (`{ linkCode, pseudonym? }`), dépose le cookie ; un téléphone déjà inscrit reçoit son contributeur existant            | `404 LINK_NOT_FOUND`, `410 LINK_CLOSED`, `429`                                                                                                                                                                                                        |
| `GET /contributors/me`           | Contributeur | Statut, pseudo, date d'inscription                                                                                               | `401 NOT_A_CONTRIBUTOR`                                                                                                                                                                                                                               |
| `PATCH /contributors/me`         | Contributeur | Changer de pseudo                                                                                                                |                                                                                                                                                                                                                                                       |
| `DELETE /contributors/me`        | Contributeur | Oublier ce téléphone                                                                                                             |                                                                                                                                                                                                                                                       |
| `POST /proposals`                | Contributeur | Envoyer une proposition (`{ entityType, action, targetId?, payload, devicePosition: { longitude, latitude, accuracy, ageMs } }`) | `403 CONTRIBUTOR_BLOCKED`, `503 CONTRIBUTIONS_PAUSED`, `503 PERIMETER_NOT_CONFIGURED`, `422 POSITION_REQUIRED`, `422 OUTSIDE_CAMPUS`, `422 POSITION_INACCURATE`, `422 POSITION_TOO_OLD`, `422 GEOMETRY_OUTSIDE_CAMPUS`, `404 TARGET_NOT_FOUND`, `429` |
| `GET /contributors/me/proposals` | Contributeur | Mes propositions, paginées                                                                                                       |                                                                                                                                                                                                                                                       |

`me` est réservé dans `/contributors/{contributorId}`.

### 9.2 Relecteurs et administrateur

| Route                                                 | Accès          | Rôle                                                                                        | Erreurs propres                                         |
| ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /proposals`                                      | Relecteur      | File, filtres `status`, `entity-type`, `contributor-id`                                     |                                                         |
| `GET /proposals/{proposalId}`                         | Relecteur      | Détail, version actuelle de la cible, indicateur de conflit                                 |                                                         |
| `PATCH /proposals/{proposalId}`                       | Relecteur      | `{ status: "accepted" \| "rejected", note? }`                                               | `409 PROPOSAL_ALREADY_REVIEWED`, `404 TARGET_NOT_FOUND` |
| `GET /contributors`                                   | Relecteur      | Liste, filtre `status`                                                                      |                                                         |
| `PATCH /contributors/{contributorId}`                 | Relecteur      | `{ status: "new" \| "trusted" \| "blocked" }` ; `blocked` refuse tout ce qui est en attente |                                                         |
| `GET /map-changes`                                    | Relecteur      | Historique, filtres `entity-type`, `entity-id`                                              |                                                         |
| `POST /map-changes`                                   | Relecteur      | Annulation (`{ revertsChangeId }`)                                                          | `409 CHANGE_OUTDATED`, `409 CHANGE_NOT_REVERTIBLE`      |
| `GET /reviewers`, `POST /reviewers`                   | Administrateur | Liste, création (`{ name }` ; la réponse contient le jeton, une seule fois)                 |                                                         |
| `DELETE /reviewers/{reviewerId}`                      | Administrateur | Révocation (ferme ses sessions)                                                             |                                                         |
| `GET /contribution-links`, `POST /contribution-links` | Administrateur | Liste, création (`{ label, isPublic? }`)                                                    |                                                         |
| `PATCH /contribution-links/{linkId}`                  | Administrateur | `{ label?, isActive?, isPublic? }`                                                          |                                                         |
| `PATCH /campus-settings`                              | Administrateur | `{ contributionsPaused }`                                                                   |                                                         |

Les routes existantes d'écriture sur les lieux et les chemins restent accessibles aux relecteurs et à l'administrateur, et inscrivent désormais leur historique. `DELETE /campus-map` devient réservée à l'administrateur.

## 10. Organisation du code

- `server/database/` : un module d'accès par table nouvelle (`contributionLinkRepository.js`, `contributorRepository.js`, `reviewerRepository.js`, `proposalRepository.js`, `mapChangeRepository.js`, `rateLimitRepository.js`), sur le modèle des modules existants (exécuteur injecté, `now` injecté).
- `server/` : les routes de contribution et de relecture dans des routeurs séparés (`contributionRoutes.js`, `reviewRoutes.js`, `administrationRoutes.js`) montés par `app.js`, pour que `app.js` ne grossisse pas indéfiniment ; un module `server/contributionRules.js` pour la présence, les limites et la publication directe.
- `shared/geo.js` : `isInsidePerimeter`.
- `public/` : `contributionMode.js` (parcours contributeur) et `reviewPanel.js` (relecture et administration) ; les outils de tracé et le formulaire de lieu de `collectMode.js` sont extraits pour être partagés, sans changer leur comportement pour l'administrateur.
- `scripts/` : `importPerimeter.js` et `purgeContributors.js`, sur le modèle de `runWithDatabase.js`.

## 11. Tests

- Unitaires : `isInsidePerimeter` (dedans, dehors, sur la marge, polygone absent ou invalide).
- Accès aux données : chaque nouveau module, migration 002 relançable, réservation atomique des limites.
- API : chaque route, matrice de droits complète, chaque refus de présence, publication directe d'un contributeur de confiance, blocage qui refuse les propositions en attente, acceptation avec et sans conflit, annulation et `CHANGE_OUTDATED`, oubli et purge à 12 mois, suspension, relecteur révoqué dont la session se ferme, relecteur qui ne peut pas vider la carte ni gérer les liens.
- Interface : pas de tests automatiques pour le navigateur dans ce dépôt. Les parcours sont vérifiés dans un navigateur au format mobile, avec une position simulée dans puis hors du périmètre : rejoindre, refus loin du campus, proposer, relire, accepter, refuser, bloquer, annuler, oublier ce téléphone.

## 12. Découpage et mise en ligne

1. Schéma 002 et accès aux données.
2. API contributeurs et propositions, présence et limites.
3. API de relecture et d'administration, historique et annulation.
4. Interface contributeur.
5. Interface de relecture et d'administration.
6. `import-perimeter`, `purge-contributors`, documentation (`README.md`, `docs/deployment.md`, `docs/decisions.md`), version 0.3.0.

Mise en ligne par `scripts/deployment/updateProduction.sh`, puis sur le serveur : `npm run import-perimeter`, création du lien public, ajout de la tâche cron mensuelle `purge-contributors` (par un fichier, avec une copie de la liste d'avant), création du premier relecteur par l'administrateur.

## 13. Critères d'acceptation

1. `npm run check` passe en local et la CI est verte.
2. Loin du campus (position simulée), les outils du contributeur ne s'ouvrent pas, et une proposition forgée hors du périmètre est refusée par le serveur (`422`).
3. Sur le campus, un téléphone rejoint par le lien public, propose un lieu, le voit « en attente » ; un relecteur l'accepte ; le lieu apparaît sur la carte publique et le contributeur voit « publiée ».
4. Un contributeur de confiance publie directement ; la modification figure dans l'historique.
5. Bloquer un téléphone refuse ses propositions en attente, et ses envois suivants reçoivent `403`.
6. Annuler une modification remet la version précédente ; l'annulation figure dans l'historique.
7. Un relecteur reçoit `403` sur la gestion des relecteurs, des liens, la suspension et « vider la carte ».
8. Suspendre les contributions renvoie `503` aux contributeurs sans gêner l'administrateur ni les relecteurs.
9. « Oublier ce téléphone » supprime le contributeur, retire ses propositions en attente et laisse ses publications attribuées à « contributeur supprimé ».
10. En production, le périmètre est importé et visible en mode collecte ; la tâche mensuelle de purge est en place, la liste des tâches cron d'avant ayant été sauvegardée.

## 14. Risques

| Risque                                                        | Parade                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Position GPS simulée                                          | Contrôle de la géométrie par le serveur, file de validation, limites, blocage                                                  |
| Contour OpenStreetMap qui laisse de côté une annexe du campus | Marge de 50 m ; correction du contour dans OpenStreetMap puis nouvel import                                                    |
| Beaucoup d'étudiants derrière la même adresse IP              | Limites par connexion larges, limite réelle par téléphone                                                                      |
| File de validation qui s'allonge                              | Compteur visible, contributeurs de confiance, plusieurs relecteurs                                                             |
| Téléphone changé ou navigateur vidé                           | Statut de confiance perdu : le relecteur le réaccorde ; limite acceptée lors de la conception                                  |
| Taille des changements dans l'interface                       | Outils de tracé extraits sans changement de comportement, vérification du parcours de l'administrateur à chaque PR d'interface |

## 15. Écart par rapport aux échanges de conception

Le statut `superseded` envisagé pour les propositions est remplacé par `withdrawn` : aucun cas ne le produisait, alors qu'« Oublier ce téléphone » et la purge doivent retirer des propositions en attente sans les compter comme refusées.
