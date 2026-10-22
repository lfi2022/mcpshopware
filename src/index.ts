import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from "jose";
import { LocalOAuthProvider } from './local-oauth.js';
import { z } from "zod";

type Json = Record<string, unknown>;

const jsonObject = z.record(z.unknown());
const jsonArray = z.array(z.record(z.unknown()));
const entityName = z.string().regex(/^[a-z][a-z0-9_]*$/, "Nom d'entité DAL invalide");
const identifier = z.string().regex(/^[a-f0-9]{32}$/i, "Un UUID Shopware hexadécimal est requis");

function config() {
  const raw = process.env.SHOPWARE_URL;
  if (!raw) throw new Error("SHOPWARE_URL est manquant.");
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error("SHOPWARE_URL doit être HTTP(S).");
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error("HTTPS est requis sauf pour localhost.");
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

let accessToken: string | undefined = process.env.SHOPWARE_ACCESS_TOKEN;
let expiresAt = 0;

async function token(): Promise<string> {
  if (accessToken && expiresAt > Date.now() + 30_000) return accessToken;
  if (process.env.SHOPWARE_ACCESS_TOKEN) return process.env.SHOPWARE_ACCESS_TOKEN;
  const clientId = process.env.SHOPWARE_CLIENT_ID;
  const clientSecret = process.env.SHOPWARE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Définissez SHOPWARE_ACCESS_TOKEN ou SHOPWARE_CLIENT_ID et SHOPWARE_CLIENT_SECRET.");
  const response = await fetch(new URL('/api/oauth/token', config()), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  });
  const body = await response.json().catch(() => ({})) as Json;
  if (!response.ok || typeof body.access_token !== 'string') throw new Error(`Authentification Shopware échouée (${response.status}): ${safeError(body)}`);
  accessToken = body.access_token;
  expiresAt = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in * 1000 : 3_300_000);
  return accessToken;
}

function safeError(value: unknown) {
  const text = JSON.stringify(value);
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
}

async function api(path: string, method = 'GET', body?: unknown) {
  if (!path.startsWith('/api/')) throw new Error("Seules les routes /api/* sont autorisées.");
  const response = await fetch(new URL(path, config()), {
    method,
    headers: { authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : { success: response.ok, status: response.status }; } catch { /* text response */ }
  if (!response.ok) throw new Error(`Shopware API ${method} ${path} a répondu ${response.status}: ${safeError(data)}`);
  return data;
}

async function apiBinary(path: string, contentType: string, bytes: Uint8Array) {
  const response = await fetch(new URL(path, config()), {
    method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': contentType }, body: bytes as unknown as BodyInit
  });
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : { success: response.ok, status: response.status }; } catch { /* text response */ }
  if (!response.ok) throw new Error(`Téléversement média échoué (${response.status}): ${safeError(data)}`);
  return data;
}

function result(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function mutatingNotice(action: string) { return `Opération confirmée : ${action}`; }
function assertConfirmed(confirm: boolean, operation: string) { if (!confirm) throw new Error(`${operation} peut modifier Shopware. Relancez avec confirm: true après validation.`); }

const server = new McpServer({ name: 'shopware6-admin', version: '0.1.0' });

server.tool('shopware_status', 'Teste l’authentification Admin API et retourne des informations de l’instance.', {}, async () => result(await api('/api/_info/version')));
server.tool('shopware_entities', 'Liste les définitions d’entités disponibles, y compris celles des extensions.', {}, async () => result(await api('/api/_info/entity-schema.json')));

server.tool('shopware_search', 'Recherche une entité DAL avec les critères Shopware (filter, associations, includes, sort, page, limit…).', {
  entity: entityName.describe('Ex. product, order, customer, category, promotion, cms_page.'),
  criteria: jsonObject.optional().describe('Critères DAL complets Shopware.'),
}, async ({ entity, criteria }) => result(await api(`/api/search/${entity}`, 'POST', criteria ?? {})));

server.tool('shopware_get', 'Lit une entité par UUID. Ajoutez associations dans criteria si nécessaire.', {
  entity: entityName, id: identifier, criteria: jsonObject.optional()
}, async ({ entity, id, criteria }) => result(await api(`/api/${entity}/${id}`, 'POST', criteria ?? {})));

server.tool('shopware_create', 'Crée une entité DAL.', {
  entity: entityName, id: identifier.optional(), payload: jsonObject, confirm: z.boolean().default(false)
}, async ({ entity, id, payload, confirm }) => {
  assertConfirmed(confirm, 'La création');
  return result({ message: mutatingNotice('création'), response: await api(`/api/${entity}${id ? `/${id}` : ''}`, 'POST', payload) });
});

server.tool('shopware_upsert', 'Crée ou met à jour une entité DAL.', {
  entity: entityName, id: identifier.optional(), payload: jsonObject, confirm: z.boolean().default(false)
}, async ({ entity, id, payload, confirm }) => {
  assertConfirmed(confirm, 'L’upsert');
  return result({ message: mutatingNotice('upsert'), response: await api(`/api/${entity}${id ? `/${id}` : ''}`, 'PATCH', payload) });
});

server.tool('shopware_update', 'Met à jour une entité DAL existante.', {
  entity: entityName, id: identifier, payload: jsonObject, confirm: z.boolean().default(false)
}, async ({ entity, id, payload, confirm }) => {
  assertConfirmed(confirm, 'La mise à jour');
  return result({ message: mutatingNotice('mise à jour'), response: await api(`/api/${entity}/${id}`, 'PATCH', payload) });
});

server.tool('shopware_delete', 'Supprime définitivement une entité DAL.', { entity: entityName, id: identifier, confirm: z.boolean().default(false) }, async ({ entity, id, confirm }) => {
  assertConfirmed(confirm, 'La suppression');
  return result({ message: mutatingNotice('suppression'), response: await api(`/api/${entity}/${id}`, 'DELETE') });
});

server.tool('shopware_sync', 'Exécute des opérations de masse Shopware Sync API (upsert, delete…).', { operations: jsonArray, confirm: z.boolean().default(false) }, async ({ operations, confirm }) => {
  assertConfirmed(confirm, 'La synchronisation de masse');
  return result({ message: mutatingNotice('synchronisation de masse'), response: await api('/api/_action/sync', 'POST', operations) });
});

server.tool('shopware_transition_state', 'Exécute une transition d’état sur une commande, une transaction ou une livraison.', {
  scope: z.enum(['order', 'order-transaction', 'order-delivery']), id: identifier,
  transition: z.string().regex(/^[a-z][a-z0-9_-]*$/), confirm: z.boolean().default(false)
}, async ({ scope, id, transition, confirm }) => {
  assertConfirmed(confirm, 'La transition d’état');
  return result({ message: mutatingNotice(`transition ${transition}`), response: await api(`/api/_action/${scope}/${id}/state/${transition}`, 'POST', {}) });
});

server.tool('shopware_upload_media', 'Attache un fichier à une entité media existante, depuis une URL ou une chaîne base64.', {
  mediaId: identifier, fileName: z.string().regex(/^.+\.[A-Za-z0-9]+$/).max(255), url: z.string().url().optional(), base64: z.string().min(1).optional(), contentType: z.string().min(1).default('application/octet-stream'), confirm: z.boolean().default(false)
}, async ({ mediaId, fileName, url, base64, contentType, confirm }) => {
  assertConfirmed(confirm, 'L’import du média');
  if ((url ? 1 : 0) + (base64 ? 1 : 0) !== 1) throw new Error('Fournissez exactement url ou base64.');
  const dot = fileName.lastIndexOf('.');
  const baseName = fileName.slice(0, dot);
  const extension = fileName.slice(dot + 1).toLowerCase();
  const endpoint = `/api/_action/media/${mediaId}/upload?extension=${encodeURIComponent(extension)}&fileName=${encodeURIComponent(baseName)}`;
  const response = url
    ? await api(endpoint, 'POST', { url })
    : await apiBinary(endpoint, contentType, Buffer.from(base64!, 'base64'));
  return result({ message: mutatingNotice('import média'), response });
});

server.tool('shopware_action', 'Exécute une action Admin API documentée non couverte par un autre outil (cache, index, documents, import/export, config…). Les routes OAuth sont interdites.', {
  path: z.string().regex(/^\/api\/_action\/[a-zA-Z0-9_./-]+(?:\?[a-zA-Z0-9_=&.-]+)?$/),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('POST'), body: jsonObject.optional(), confirm: z.boolean().default(false)
}, async ({ path, method, body, confirm }) => {
  if (method !== 'GET') assertConfirmed(confirm, `L’action ${path}`);
  return result({ ...(method === 'GET' ? {} : { message: mutatingNotice(path) }), response: await api(path, method, body) });
});

server.tool('shopware_admin_request', 'Échappatoire pour une route Admin API officielle non couverte par les autres outils (extensions incluses). Les routes OAuth sont interdites.', {
  path: z.string().regex(/^\/api\/(?!oauth(?:\/|$))[a-zA-Z0-9_./-]+(?:\?[a-zA-Z0-9_=&.-]+)?$/),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('GET'), body: jsonObject.optional(), confirm: z.boolean().default(false)
}, async ({ path, method, body, confirm }) => {
  if (method !== 'GET') assertConfirmed(confirm, `La requête ${path}`);
  return result({ ...(method === 'GET' ? {} : { message: mutatingNotice(path) }), response: await api(path, method, body) });
});

const transportMode = process.env.MCP_TRANSPORT ?? 'stdio';

if (transportMode === 'http') {
  const port = Number.parseInt(process.env.MCP_PORT ?? '3000', 10);
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const publicUrl = process.env.MCP_PUBLIC_URL?.replace(/\/$/, '');
  const authMode = process.env.MCP_AUTH_MODE ?? 'bearer';
  const bearerToken = process.env.MCP_BEARER_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT doit être un port valide.');
  if (!['bearer', 'oauth', 'local-oauth'].includes(authMode)) throw new Error("MCP_AUTH_MODE doit être 'bearer', 'oauth' ou 'local-oauth'.");
  if (authMode === 'bearer' && (!bearerToken || bearerToken.length < 24)) throw new Error('En mode bearer, définissez un MCP_BEARER_TOKEN aléatoire d’au moins 24 caractères.');
  const issuer = process.env.OAUTH_ISSUER?.replace(/\/$/, '');
  const audience = process.env.OAUTH_AUDIENCE ?? publicUrl;
  const scopes = (process.env.OAUTH_SCOPES ?? 'shopware:admin').split(/\s+/).filter(Boolean);
  if (authMode === 'oauth' && (!publicUrl?.startsWith('https://') || !issuer?.startsWith('https://') || !audience)) {
    throw new Error('En mode OAuth, MCP_PUBLIC_URL, OAUTH_ISSUER et OAUTH_AUDIENCE (ou MCP_PUBLIC_URL) HTTPS sont requis.');
  }
  const localOAuth = authMode === 'local-oauth'
    ? new LocalOAuthProvider({
      publicUrl: publicUrl ?? '', adminUsername: process.env.OAUTH_ADMIN_USERNAME ?? '', adminPassword: process.env.OAUTH_ADMIN_PASSWORD ?? '',
      signingSecret: process.env.OAUTH_SIGNING_SECRET ?? '', storagePath: process.env.OAUTH_STORAGE_PATH ?? './.data/oauth-clients.json', scopes
    })
    : undefined;
  if (authMode === 'local-oauth' && (!publicUrl?.startsWith('https://') || !process.env.OAUTH_ADMIN_USERNAME || !process.env.OAUTH_ADMIN_PASSWORD)) {
    throw new Error('En mode local-oauth, MCP_PUBLIC_URL HTTPS, OAUTH_ADMIN_USERNAME et OAUTH_ADMIN_PASSWORD sont requis.');
  }
  if (localOAuth) await localOAuth.init();
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function verifyOAuth(authorization: string | undefined) {
    if (!authorization?.startsWith('Bearer ')) return false;
    try {
      if (!jwks) {
        const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
        const metadata = await discovery.json() as { jwks_uri?: string };
        if (!discovery.ok || !metadata.jwks_uri?.startsWith('https://')) throw new Error('Découverte OIDC invalide.');
        jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
      }
      const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer, audience });
      const tokenScopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      return scopes.every(scope => tokenScopes.includes(scope));
    } catch (error) {
      console.error('Jeton OAuth MCP refusé:', error instanceof Error ? error.message : error);
      return false;
    }
  }
  function unauthorized(response: import('node:http').ServerResponse) {
    const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;
    const header = authMode === 'oauth' || authMode === 'local-oauth'
      ? `Bearer resource_metadata="${metadataUrl}", scope="${scopes.join(' ')}", error="invalid_token"`
      : 'Bearer';
    response.writeHead(401, { 'www-authenticate': header }).end();
  }

  // A stateful transport is required so one MCP connection can call tools/list and tools/call after initialize.
  // The client receives Mcp-Session-Id during initialize and returns it on subsequent requests.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const httpServer = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (localOAuth && await localOAuth.handle(request, response, path)) return;
    if ((authMode === 'oauth' || authMode === 'local-oauth') && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ resource: publicUrl, authorization_servers: [authMode === 'local-oauth' ? publicUrl : issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] }));
      return;
    }
    if (path === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (path !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const authenticated = authMode === 'oauth' ? await verifyOAuth(request.headers.authorization)
      : authMode === 'local-oauth' ? await localOAuth!.verify(request.headers.authorization)
      : request.headers.authorization === `Bearer ${bearerToken}`;
    if (!authenticated) return unauthorized(response);
    try {
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error('Erreur MCP HTTP:', error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
  httpServer.listen(port, host, () => console.error(`Shopware MCP HTTP écoute sur http://${host}:${port}/mcp`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => httpServer.close(() => process.exit(0)));
} else if (transportMode === 'stdio') {
  await server.connect(new StdioServerTransport());
} else {
  throw new Error("MCP_TRANSPORT doit être 'stdio' ou 'http'.");
}
