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
