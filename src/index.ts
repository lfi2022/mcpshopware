import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

for (const [name, verb, description] of [
  ['shopware_create', 'POST', 'Crée une entité DAL.'],
  ['shopware_upsert', 'PATCH', 'Crée ou met à jour une entité DAL.'],
  ['shopware_update', 'PATCH', 'Met à jour une entité DAL existante.'],
] as const) {
  server.tool(name, description, { entity: entityName, id: identifier.optional(), payload: jsonObject, confirm: z.boolean().default(false) }, async ({ entity, id, payload, confirm }) => {
    assertConfirmed(confirm, description);
    const path = name === 'shopware_update' ? `/api/${entity}/${id!}` : `/api/${entity}${id ? `/${id}` : ''}`;
    return result({ message: mutatingNotice(description), response: await api(path, verb, payload) });
  });
}

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

server.tool('shopware_upload_media', 'Charge un média par URL distante ou contenu base64 dans un dossier média.', {
  mediaFolderId: identifier, fileName: z.string().min(1).max(255), url: z.string().url().optional(), base64: z.string().min(1).optional(), confirm: z.boolean().default(false)
}, async ({ mediaFolderId, fileName, url, base64, confirm }) => {
  assertConfirmed(confirm, 'L’import du média');
  if ((url ? 1 : 0) + (base64 ? 1 : 0) !== 1) throw new Error('Fournissez exactement url ou base64.');
  const endpoint = url ? '/api/_action/media/upload-by-url' : '/api/_action/media/upload';
  const payload = url ? { mediaFolderId, fileName, url } : { mediaFolderId, fileName, file: base64 };
  return result({ message: mutatingNotice('import média'), response: await api(endpoint, 'POST', payload) });
});

server.tool('shopware_action', 'Exécute une action Admin API documentée non couverte par un autre outil (cache, index, documents, import/export, config…). Les routes OAuth sont interdites.', {
  path: z.string().regex(/^\/api\/_action\/[a-zA-Z0-9_./-]+(?:\?[a-zA-Z0-9_=&.-]+)?$/),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('POST'), body: jsonObject.optional(), confirm: z.boolean().default(false)
}, async ({ path, method, body, confirm }) => {
  if (method !== 'GET') assertConfirmed(confirm, `L’action ${path}`);
  return result({ ...(method === 'GET' ? {} : { message: mutatingNotice(path) }), response: await api(path, method, body) });
});

await server.connect(new StdioServerTransport());
