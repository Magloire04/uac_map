# Déploiement

L'application tourne sur un hébergement cPanel mutualisé (CloudLinux, LiteSpeed), à l'adresse `https://uacmap.bytechnum.com`. Seule la branche `main` est déployée. Dans ce document, `<compte>` désigne l'identifiant du compte cPanel (affiché dans « Informations générales » de cPanel, et dans la variable `$USER` en SSH).

## 1. Installation initiale

À faire une seule fois, dans l'ordre.

### 1.1 Base de données

1. cPanel, Database Wizard.
2. Base : `uacmap` (cPanel la nomme `<compte>_uacmap`).
3. Utilisateur : `uacmap` (nommé `<compte>_uacmap`). Mot de passe de 32 lettres et chiffres, généré en SSH avec `tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32; echo`, collé dans le champ du mot de passe, puis rangé dans un gestionnaire de mots de passe. Ne pas utiliser le générateur de cPanel : ses symboles (`#`, guillemets, barre oblique inverse) seraient mal lus dans `.env` et dans le fichier d'identifiants, et la connexion échouerait sans explication claire.
4. Droits : ALL PRIVILEGES, sur cette base uniquement. Ce compte héberge d'autres sites : l'utilisateur de la carte ne doit avoir aucun droit sur leurs bases.

### 1.2 Code

1. cPanel, Git Version Control, Create.
2. Clone URL : `https://github.com/Magloire04/uac_map.git`. Repository Path : `/home/<compte>/uac_map`, hors de `public_html`.
3. En SSH : `git -C ~/uac_map checkout main`.

### 1.3 Application Node.js

1. Vérifier que `uacmap.bytechnum.com` figure dans la liste « URL de l'application » de Setup Node.js App. Sinon, déclarer d'abord le sous-domaine dans l'hébergement Spaceship.
2. Setup Node.js App, Créer une application :
   - Version de Node.js : 24.21.0
   - Mode d'application : Production
   - Racine de l'application : `uac_map`
   - URL de l'application : `uacmap.bytechnum.com`
   - Fichier de démarrage de l'application : `app.cjs`
3. Aucune variable n'est à saisir dans cet écran : la configuration est dans le fichier `.env` (1.5).
4. Noter la commande affichée en haut de la page de l'application (« source /home/<compte>/nodevenv/uac_map/24/bin/activate && cd /home/<compte>/uac_map »). Elle ouvre l'environnement Node en SSH.

### 1.4 Dépendances

Dans Setup Node.js App, bouton « Run NPM Install », ou en SSH, dans l'environnement Node :

```bash
npm install --omit=dev
```

Ne jamais créer de dossier `node_modules` à la main ni lancer `npm ci` : CloudLinux range les dépendances dans l'environnement de l'application et relie `node_modules` à cet emplacement.

### 1.5 Fichier `.env`

En SSH, dans l'environnement Node :

```bash
cd ~/uac_map
cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"   # jeton du mode collecte
nano .env
```

| Variable            | Valeur                                      |
| ------------------- | ------------------------------------------- |
| `NODE_ENV`          | `production`                                |
| `DATABASE_HOST`     | `localhost`                                 |
| `DATABASE_PORT`     | `3306`                                      |
| `DATABASE_NAME`     | `<compte>_uacmap`                           |
| `DATABASE_USER`     | `<compte>_uacmap`                           |
| `DATABASE_PASSWORD` | Mot de passe de l'étape 1.1                 |
| `ADMIN_TOKEN`       | Jeton généré ci-dessus                      |
| `PUBLIC_URL`        | `https://uacmap.bytechnum.com`              |
| `TRUST_PROXY`       | `loopback`, à ajuster à l'étape 2 si besoin |
| `HTTPS_ENABLED`     | `false`                                     |

Les valeurs s'écrivent sans guillemets tant qu'elles ne contiennent que des lettres, des chiffres, `-` et `_` : c'est le cas du jeton et du mot de passe générés ci-dessus. Un `#` non protégé couperait la valeur.

Le serveur lit ce fichier au démarrage sans écraser une variable déjà définie, et les commandes (`npm run …`) le lisent aussi.

### 1.6 Schéma, puis démarrage

```bash
npm run database:migrate
```

Puis, dans Setup Node.js App, bouton RESTART. Au premier démarrage en production, la carte est vide : la démonstration n'est jamais chargée automatiquement.

### 1.7 Identifiants des sauvegardes

```bash
cat > ~/.uac_map.my.cnf <<'FIN'
[client]
user=<compte>_uacmap
password=<mot de passe de l'étape 1.1>
FIN
chmod 600 ~/.uac_map.my.cnf
~/uac_map/scripts/deployment/backupDatabase.sh
```

Le fichier est dédié à la carte : le `~/.my.cnf` éventuel du compte n'est pas touché. La dernière commande doit afficher `Sauvegarde : /home/<compte>/backups/uac_map/uac_map-…sql.gz`.

### 1.8 Sauvegarde quotidienne

cPanel, Tâches Cron, ajouter :

- Fréquence : `0 3 * * *`
- Commande : `/home/<compte>/uac_map/scripts/deployment/backupDatabase.sh >> /home/<compte>/backups/uac_map/sauvegarde.log 2>&1`

## 2. Vérifications après installation

1. `https://uacmap.bytechnum.com/api/v1/health` affiche `{"data":{"status":"ok"}}`.
2. Sur téléphone, la carte s'affiche et le GPS fonctionne.
3. Connexion au mode collecte avec le jeton : dans les outils du navigateur (Application, Cookies), le cookie `uac_admin_session` est marqué Secure.
4. Blocage : depuis un téléphone en 4G, saisir dix fois un faux jeton. La onzième tentative affiche « Trop de tentatives ». Pendant ce temps, un ordinateur en Wi-Fi peut toujours se connecter. Si l'ordinateur est bloqué lui aussi, LiteSpeed ne transmet pas l'adresse du client depuis une adresse locale : essayer `TRUST_PROXY=1` dans `.env`, redémarrer et refaire le test.
5. Créer un lieu, redémarrer l'application (RESTART) : le lieu est toujours là et la session reste ouverte.
6. Le QR code d'un lieu, scanné, ouvre `https://uacmap.bytechnum.com/?ici=<identifiant>`.
7. Télécharger une sauvegarde (Gestionnaire de fichiers, `backups/uac_map`) et la réimporter en local (section 4).
8. Le code source de l'accueil contient `<link rel="canonical" href="https://uacmap.bytechnum.com/" />`. Sinon, `PUBLIC_URL` est vide ou erroné dans `.env`.

## 3. Mise à jour

Après la fusion d'une version dans `main` :

```bash
~/uac_map/scripts/deployment/updateProduction.sh
```

Le script sauvegarde la base, récupère `main`, installe les dépendances, applique les migrations et redémarre l'application. Il s'arrête à la première erreur et affiche alors l'étape en cause et les commandes pour revenir à la version précédente, dont il a noté le commit avant de commencer. Si l'échec survient à l'étape 4 (migrations) ou 5 (redémarrage), restaurer aussi la sauvegarde faite à l'étape 1 (section 4). Si le chemin de l'environnement Node diffère de `~/nodevenv/uac_map/24/bin/activate`, le préciser : `NODE_ENVIRONMENT_ACTIVATE=<chemin> ~/uac_map/scripts/deployment/updateProduction.sh`.

## 4. Sauvegardes et restauration

- Les exports sont dans `~/backups/uac_map/`, un par nuit et un avant chaque mise à jour, conservés 14 jours.
- Ils restent sur le même serveur que la base : télécharger le plus récent chaque semaine (Gestionnaire de fichiers).

Restaurer en production (application arrêtée dans Setup Node.js App) :

```bash
gunzip -c ~/backups/uac_map/uac_map-AAAAMMJJ-HHMM.sql.gz | mariadb --defaults-file=$HOME/.uac_map.my.cnf <compte>_uacmap
```

Vérifier un export en local (WampServer, MariaDB sur le port 3307) :

```bash
mariadb -h 127.0.0.1 -P 3307 -u root -e "CREATE DATABASE uac_map_restauration CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c uac_map-AAAAMMJJ-HHMM.sql.gz | mariadb -h 127.0.0.1 -P 3307 -u root uac_map_restauration
```

## 5. En cas de problème

| Symptôme                                                                          | Cause probable                                                  | Action                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Page d'erreur de l'hébergeur                                                      | L'application refuse de démarrer                                | Lire le fichier `stderr.log` à la racine de l'application : il commence par « Démarrage impossible : » suivi de la raison |
| « Variables d'environnement manquantes »                                          | `.env` incomplet                                                | Compléter `.env`, puis RESTART                                                                                            |
| « Schéma de la base en retard »                                                   | Migrations non appliquées                                       | `npm run database:migrate` dans l'environnement Node, puis RESTART                                                        |
| « Base de données injoignable »                                                   | Identifiants ou nom de base erronés                             | Vérifier `DATABASE_*` dans `.env`                                                                                         |
| Tout le monde bloqué après des échecs de connexion                                | `TRUST_PROXY` inadapté                                          | Voir la vérification 4 de la section 2                                                                                    |
| Sauvegarde : « Ni mariadb-dump ni mysqldump n'est disponible sur ce serveur »     | Outils clients MariaDB absents du PATH SSH                      | Demander à l'hébergeur où ils se trouvent ; en attendant, exporter la base depuis phpMyAdmin (Exporter)                   |
| Restauration : « mariadb: command not found »                                     | Ancien nom du client                                            | Remplacer `mariadb` par `mysql` dans la commande                                                                          |
| Sauvegarde : « SSL is required, but the server does not support it »              | Le client MariaDB exige TLS, le serveur local ne le propose pas | Ajouter une ligne `skip-ssl` dans `~/.uac_map.my.cnf`                                                                     |
| Toute proposition refusée : « Le périmètre du campus n’est pas encore configuré » | Périmètre non importé                                           | Section 6.1                                                                                                               |
| Import du périmètre : « Overpass a répondu 429 » ou 504                           | Serveur Overpass surchargé                                      | Réessayer plus tard, ou `--fichier` (section 6.1)                                                                         |

## 6. Contribution ouverte (depuis la version 0.3.0)

### 6.1 Périmètre du campus

En SSH, dans l'environnement Node :

```bash
cd ~/uac_map
npm run import-perimeter
```

La commande doit afficher « Périmètre enregistré : N points. ». Si Overpass ne répond pas, réessayer plus tard, changer de serveur avec `OVERPASS_URL`, ou téléverser un export et lancer `npm run import-perimeter -- --fichier <fichier>` (l'export `data/osm-brut.json` laissé par `npm run import-osm` convient). À refaire seulement si le contour change dans OpenStreetMap.

### 6.2 Lien public et relecteurs

Dans l'appli, mode collecte avec `ADMIN_TOKEN`, À relire > Administration :

1. Créer le lien public : saisir un libellé, cocher « Lien public », puis « Créer le lien ». Imprimer ensuite son affiche « Contribuez à la carte », en tête de la page ouverte par menu > Imprimer les QR codes « Vous êtes ici ».
2. Créer chaque relecteur. Son jeton ne s'affiche qu'une fois : le transmettre par un canal sûr.

### 6.3 Purge mensuelle des contributeurs inactifs

Par l'écran Tâches Cron de cPanel (le plus sûr). Avant d'ajouter la purge, copier dans un fichier daté les lignes de la liste des tâches existantes, affichée en bas de cet écran : elle pourra être rétablie en cas d'erreur. Puis ajouter la tâche :

- Fréquence : `0 4 1 * *`
- Commande : `/bin/bash -c 'source /home/<compte>/nodevenv/uac_map/24/bin/activate && cd /home/<compte>/uac_map && npm run purge-contributors' >> /home/<compte>/backups/uac_map/purge.log 2>&1`

En SSH, ne jamais modifier la liste par un tube (`crontab -l | … | crontab -`) : une erreur l'efface pour tous les sites du compte. Toujours passer par un fichier :

```bash
crontab -l > ~/crontab-sauvegarde-$(date +%Y%m%d-%H%M).txt
wc -l ~/crontab-sauvegarde-*.txt
cp ~/crontab-sauvegarde-<horodatage>.txt ~/crontab-nouvelle.txt
nano ~/crontab-nouvelle.txt          # ajouter la ligne de la purge à la fin
crontab ~/crontab-nouvelle.txt
crontab -l | wc -l                   # une ligne de plus qu'avant
```

### 6.4 Vérifications

1. `https://uacmap.bytechnum.com/api/v1/campus-map` : `settings.perimeter` n'est pas vide.
2. Sur un téléphone, loin du campus : Contribuer à la carte, rejoindre, les outils restent grisés avec « Vous semblez hors du campus… ».
3. Sur le campus : proposer un lieu, le voir « En attente » dans Mes propositions ; l'accepter en mode collecte ; il apparaît sur la carte et le contributeur le voit « Publiée ».
4. Un relecteur ne voit ni l'onglet Administration ni « Vider la carte ».
5. `~/backups/uac_map/purge.log` se remplit le 1er de chaque mois.
