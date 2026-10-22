# Shopware 6 Admin MCP

Serveur MCP local pour administrer une instance Shopware 6 par son **Admin API**. Il utilise le flux OAuth `client_credentials` d'une intégration Shopware et ne journalise jamais les secrets ni les jetons.

## Installation

```powershell
npm install
npm run build
Copy-Item .env.example .env
```

Renseignez les variables de `.env` (chargé automatiquement par le serveur) ou de l'environnement qui lance le processus : `SHOPWARE_URL`, `SHOPWARE_CLIENT_ID` et `SHOPWARE_CLIENT_SECRET`.

Dans Shopware : **Paramètres > Système > Intégrations**, créez une intégration avec les droits nécessaires. Le mode Administrateur donne l'accès complet ; une intégration ACL restreinte est préférable en production.

> La clé nommée **API access key** dans un canal de vente sert uniquement à la Store API (`sw-access-key`) : catalogue, panier et checkout. Elle ne peut pas administrer les produits, commandes, clients ou réglages avec l’Admin API. L’administration complète de ce connecteur exige donc une intégration Admin API (`SHOPWARE_CLIENT_ID` et `SHOPWARE_CLIENT_SECRET`) ou un jeton Admin API déjà émis.

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
- `shopware_sync` : opérations de masse sur `/api/_action/sync`.
- `shopware_action` : accès contrôlé aux actions Admin API non couvertes, par exemple documents, cache, indexation, import/export, règles et configuration.
- `shopware_admin_request` : accès de dernier recours à toute route officielle `/api/*`, y compris les routes d'extensions ; les routes OAuth sont bloquées.
- `shopware_transition_state` : transitions des commandes, transactions et livraisons.
- `shopware_upload_media` : import d'un fichier base64 ou depuis une URL dans une entité `media` existante.

Les outils DAL universels rendent le serveur compatible avec les entités natives, les champs personnalisés et les entités ajoutées par des extensions, sans figer une liste de routes qui diffère selon la version de Shopware.

## Sécurité

- Les URL HTTP ne sont acceptées que pour `localhost`/`127.0.0.1`/`::1`.
- Toute opération destructive exige `confirm: true`.
- Les routes commençant par `/api/oauth` et les URL externes sont refusées par `shopware_action`.
- Pour une boutique de production, utilisez une intégration ACL avec le minimum de droits et une instance de test avant les opérations de masse.

## Déploiement PM2 derrière un reverse proxy

Le transport local par défaut est `stdio` et **n'ouvre pas de port**. Pour un déploiement serveur, utilisez le mode MCP Streamable HTTP. Le serveur écoute volontairement sur `127.0.0.1` : seul le reverse proxy doit être public.

```bash
npm ci
npm run build
export SHOPWARE_URL='https://shop.example.com'
export SHOPWARE_CLIENT_ID='...'
export SHOPWARE_CLIENT_SECRET='...'
export MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
pm2 start ecosystem.config.cjs
pm2 save
```

L'URL MCP est `https://mcp.example.com/mcp`; `GET /healthz` est disponible localement pour la supervision. Ajoutez le jeton dans le client sous la forme `Authorization: Bearer <MCP_BEARER_TOKEN>`.

### OAuth 2.1 pour connecter ChatGPT

Un jeton Bearer statique convient aux tests techniques, mais n’est pas approprié pour partager le connecteur avec des utilisateurs ChatGPT. Le serveur intègre un rôle de **resource server** OAuth 2.1 : il publie les métadonnées MCP, découvre les clés JWKS de votre fournisseur OIDC et vérifie signature, émetteur, audience, expiration et scope de chaque jeton.

Utilisez un fournisseur d’identité OIDC déjà en place (Auth0, Keycloak, Microsoft Entra ID, etc.), puis définissez :

```bash
export MCP_TRANSPORT=http
export MCP_AUTH_MODE=oauth
export MCP_PUBLIC_URL=https://mcp.example.com
export OAUTH_ISSUER=https://id.example.com/realms/shopware
export OAUTH_AUDIENCE=https://mcp.example.com
export OAUTH_SCOPES=shopware:admin
pm2 restart shopware6-admin-mcp --update-env
```

Votre fournisseur doit prendre en charge OAuth Authorization Code avec PKCE S256, publier sa découverte OIDC et délivrer un JWT avec `aud=https://mcp.example.com` et le scope `shopware:admin`. Dans ChatGPT : **Plugins → Add custom MCP server → Server URL** `https://mcp.example.com/mcp` → choisissez **OAuth**. Copiez exactement l’URL de redirection affichée par ChatGPT dans les URL autorisées de votre fournisseur d’identité. ChatGPT découvrira `/.well-known/oauth-protected-resource` et lancera le flux de connexion.

Les identifiants Shopware restent sur le serveur dans les variables `SHOPWARE_*`; l’utilisateur ChatGPT ne les voit jamais et son jeton OAuth ne donne accès qu’au connecteur.

### Fournisseur OAuth local autonome

Pour une installation privée sans Auth0, Keycloak ou autre dépendance, le projet peut aussi être son propre fournisseur OAuth. Activez `MCP_AUTH_MODE=local-oauth`, puis créez un compte de connexion dédié (ce compte ne doit pas être votre mot de passe Shopware) et une clé de signature :

```bash
MCP_AUTH_MODE=local-oauth
MCP_PUBLIC_URL=https://mcp2.lfinfo.be
OAUTH_ADMIN_USERNAME=admin-mcp
OAUTH_ADMIN_PASSWORD='un-mot-de-passe-long-et-unique'
OAUTH_SIGNING_SECRET="$(openssl rand -base64 48)"
OAUTH_STORAGE_PATH=./.data/oauth-clients.json
```

Ce mode expose la découverte OAuth, l’inscription dynamique du client ChatGPT, Authorization Code + PKCE S256, une page de connexion locale et des jetons signés. Les clients OAuth enregistrés sont stockés dans `.data/oauth-clients.json`, hors Git ; sauvegardez ce fichier avec votre `.env`. Utilisez HTTPS, des permissions `600` sur `.env`, et ne perdez pas `OAUTH_SIGNING_SECRET` (sinon les sessions existantes sont invalidées).

Exemple Nginx pour un sous-domaine MCP dédié :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

Ce bloc expose `/mcp`, `/healthz`, `/.well-known/oauth-protected-resource` et les routes `/oauth/*` nécessaires au mode OAuth.

Ne publiez jamais le port `3000` directement et ne stockez pas les secrets dans `ecosystem.config.cjs` ou Git.

## Références Shopware

Le connecteur suit l'Admin API (`/api/*`), l'authentification OAuth des intégrations, les critères DAL et la Sync API. La référence exacte de votre instance est disponible dans son interface : `/api/_info/stoplightio.html`.
