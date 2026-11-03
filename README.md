# Shopware 6 Admin MCP

Serveur MCP local pour administrer une instance Shopware 6 par son **Admin API**. Il utilise le flux OAuth `client_credentials` d'une intégration Shopware et ne journalise jamais les secrets ni les jetons.

## Installation

### Déploiement HTTP avec PM2

Depuis le dossier du projet sur le serveur, après transfert de la dernière version :

```bash
npm ci --include=dev
npm run build
pm2 startOrRestart ecosystem.config.cjs --update-env
curl -sS http://127.0.0.1:4569/healthz
```

Le fichier `.env` doit définir `MCP_TRANSPORT=http`, `MCP_HOST=0.0.0.0`,
`MCP_PORT=4569`, `MCP_PUBLIC_URL=https://mcp2.lfinfo.be` et les paramètres
d'authentification. Dans ChatGPT, l'URL MCP est `https://mcp2.lfinfo.be/mcp`.
La version 0.1.1 utilise un serveur et un transport stateless distincts pour
chaque requête HTTP : plusieurs clients peuvent initialiser leur connexion sans
collision. `/healthz` retourne la version déployée et le mode de transport.
Les lignes `[MCP]` des journaux PM2 indiquent méthode, statut HTTP et durée,
sans journaliser les en-têtes d'authentification ni les corps.

`npm test` vérifie la découverte avec plusieurs clients MCP indépendants,
successifs et simultanés. Le test ne contacte pas Shopware.

### Installation locale

```powershell
npm install
npm run build
Copy-Item .env.example .env
```

Renseignez les variables de `.env` dans l'environnement qui lance le serveur (ou dans la configuration MCP de ChatGPT/Codex) : `SHOPWARE_URL`, `SHOPWARE_CLIENT_ID` et `SHOPWARE_CLIENT_SECRET`.

Dans Shopware : **Paramètres > Système > Intégrations**, créez une intégration avec les droits nécessaires. Le mode Administrateur donne l'accès complet ; une intégration ACL restreinte est préférable en production.

Ajoutez ensuite `mcp.json` comme connecteur local. Avant de démarrer, transmettez explicitement ces variables au processus MCP :

```json
{
  "SHOPWARE_URL": "https://shop.example.com",
  "SHOPWARE_CLIENT_ID": "…",
  "SHOPWARE_CLIENT_SECRET": "…"
}
```

## Outils disponibles

### LFINFO Partner Bridge 1.9.0

La version MCP **0.1.2** ajoute **40 outils `shopware_bridge_*`** à partir des
contrôleurs du ZIP `LFINFO-Partner-Bridge-1.9.0.zip` : toutes les routes HTTP
actives sont couvertes, y compris TD SYNNEX, Copaco, Ingram et Open Icecat.
Le ZIP original est conservé sans modification. Aucun import ne démarre au lancement du MCP.

Installer et activer le plugin **TDBridge** sur la boutique désignée par
`SHOPWARE_URL`. Le MCP réutilise `SHOPWARE_CLIENT_ID` et `SHOPWARE_CLIENT_SECRET` :
aucune nouvelle variable d’environnement n’est nécessaire. Les identifiants
fournisseurs et Icecat restent configurés dans le bridge. L’intégration Shopware
doit disposer de `td_bridge:read`, `td_bridge:import`, `td_bridge:configure` et
`td_bridge:documents`, ou du rôle Administrateur. Le MCP ne contourne pas ces droits.

| Besoin | Outils (préfixe `shopware_bridge_`) |
| --- | --- |
| Découvrir les paramètres, routes et droits | `capabilities`, `stats`, `settings`, `suppliers` |
| Chercher des références | `catalogue`, `catalogue_facets`, `supplier_offers`, `ingram_catalogue` |
| Paramétrer les fournisseurs et Icecat | `save_settings`, `copaco_settings`, `copaco_save_settings`, `ingram_settings`, `ingram_save_settings` |
| Tester et diagnostiquer | `test`, `ingram_test`, `diagnose`, `diagnose_import` |
| Importer / synchroniser / enrichir une sélection | `import` (TD), `supplier_sync` (les trois fournisseurs) |
| Compléter les photos manquantes | `missing_preview`, puis `enrich_missing` |
| Synchroniser tous les produits liés actifs | `sync_preview`, puis `sync_all` |
| Suivre les traitements | `list` (`kind=jobs`, `logs` ou `links`), `workers`, `process`, `job_action` |
| Gérer les liaisons | `links`, `supplier_bind`, `ingram_link`, `reconcile` |
| Charger les catalogues | `cache_status`, `cache_action`, `copaco_status`, `copaco_refresh`, `feed_preview`, `feed_commit` |
| Lire les documents TD | `documents` (`type=orders` ou `invoices`) |

Exemple : enrichir les descriptions, caractéristiques et images de références TD
déjà liées. Vérifier d’abord les paramètres et l’aperçu :

```json
{"name":"shopware_bridge_icecat_preview","arguments":{"body":{"partNumber":"REFERENCE-TD"}}}
```

Si nécessaire, activer Icecat avec `shopware_bridge_save_settings` et un `body`
contenant `icecatEnabled`, `icecatDescription`, `icecatSpecs`, `icecatImages` à
`true`, après avoir configuré le compte Icecat. `icecatReplace` contrôle le
remplacement de contenu existant ; consulter sa valeur avant de la modifier.
Créer ensuite la tâche sur les références choisies :

```json
{"name":"shopware_bridge_import","arguments":{"body":{"parts":["REFERENCE-TD"],"type":"icecat"},"confirm":true}}
```

Pour Copaco/Ingram, utiliser `shopware_bridge_supplier_sync` avec
`body.supplier` égal à `copaco` ou `ingram`, les `parts` et `type: "icecat"`.
Les paramètres sont figés à la création de la tâche. Les imports/enrichissements
retournent un identifiant de tâche ; contrôler `list` avec `kind: "jobs"`, puis
`kind: "logs"` et `query.term` égal à cet identifiant. Les workers Shopware doivent
tourner ; `process` permet un traitement manuel d’un lot de la file.

Chaque écriture exige `confirm: true`. Les recherches POST, aperçus et lectures
de documents restent accessibles sans confirmation. L’ancienne action
`catalogue-index/{action}`, refusée par le plugin lui-même, est remplacée par
la recherche fournisseur et le cache ; `catalogue_index` conserve sa lecture d’état.
Les commandes CLI et l’installation ne disposent pas de routes HTTP dans le ZIP.

Après transfert des sources sur le serveur MCP, exécuter les commandes de
déploiement PM2 ci-dessus et actualiser les outils du connecteur. `/healthz` doit
indiquer `0.1.2`. Les tests utilisent des réponses simulées et vérifient la
couverture des routes extraites du ZIP ; ils ne valident pas une boutique réelle.

- `shopware_status` : test de connexion et version de l'API.
- `shopware_entities` : liste des entités connues par l'instance.
- `shopware_search`, `shopware_get` : lecture DAL avec critères Shopware complets.
- `shopware_create`, `shopware_upsert`, `shopware_update`, `shopware_delete` : écritures d'entités, avec confirmation explicite pour suppression.
- `shopware_update_product` : édition guidée des articles / produits (prix, stock, texte, médias, catégories, traductions…).
- `shopware_update_content_page` : édition des pages CMS, landing pages et catégories, y compris leurs métadonnées.
- `shopware_update_seo_url`, `shopware_create_custom_seo_url`, `shopware_update_seo_template` : gestion des URL et modèles SEO.
- `shopware_sync` : opérations de masse sur `/api/_action/sync`.
- `shopware_action` : accès contrôlé aux actions Admin API non couvertes, par exemple documents, cache, indexation, import/export, règles et configuration.
- `shopware_admin_request` : accès de dernier recours à toute route officielle `/api/*`, y compris les routes d'extensions ; les routes OAuth sont bloquées.
- `shopware_transition_state` : transitions des commandes, transactions et livraisons.
- `shopware_upload_media` : import d'un fichier base64 ou depuis une URL dans une entité `media` existante.
²
Les outils DAL universels rendent le serveur compatible avec les entités natives, les champs personnalisés et les entités ajoutées par des extensions, sans figer une liste de routes qui diffère selon la version de Shopware.

## Sécurité

- Les URL HTTP ne sont acceptées que pour `localhost`/`127.0.0.1`/`::1`.
- Toute opération destructive exige `confirm: true`.
- Les routes commençant par `/api/oauth` et les URL externes sont refusées par `shopware_action`.
- Pour une boutique de production, utilisez une intégration ACL avec le minimum de droits et une instance de test avant les opérations de masse.

## Références Shopware

Le connecteur suit l'Admin API (`/api/*`), l'authentification OAuth des intégrations, les critères DAL et la Sync API. La référence exacte de votre instance est disponible dans son interface : `/api/_info/stoplightio.html`.
