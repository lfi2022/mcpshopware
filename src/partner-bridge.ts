import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const object = z.record(z.unknown());
const part = z.string().trim().min(1).max(100);
const uuid = z.string().regex(/^[a-f0-9]{32}$/);
const parts = z.array(part).min(1).max(500);
const jobType = z.enum(['import', 'sync', 'icecat', 'icecat_missing']);
const supplier = z.enum(['tdsynnex', 'copaco', 'ingram']);
const base = '/api/_action/td-bridge/';

// Contract inspected in LFINFO-Partner-Bridge-1.9.0.zip, not inferred from DAL entities.
export const bridgeEndpoints = [
  ['stats', 'GET', 'stats', 'read', false, 'Statistiques du Partner Bridge et état de la synchronisation.'],
  ['settings', 'GET', 'settings', 'configure', false, 'Lit les paramètres TD SYNNEX et Icecat sans les secrets.'],
  ['save_settings', 'POST', 'settings', 'configure', true, 'Enregistre les paramètres partiels : TVA, devise, marge, catégorie, canal, syncPrice/syncStock/syncContent, icecatEnabled, icecatDescription, icecatSpecs, icecatImages, icecatTitle, icecatReplace, identifiants.'],
  ['test', 'POST', 'test', 'configure', false, 'Teste la connexion TD SYNNEX sans écrire de produit.'],
  ['diagnose', 'POST', 'diagnose', 'configure', false, 'Lit un échantillon catalogue TD brut pour contrôler le mapping. Un seul critère API.'],
  ['diagnose_import', 'GET', 'diagnose-import', 'configure', false, 'Diagnostic import en lecture seule, query.part facultatif.'],
  ['catalogue', 'POST', 'catalogue', 'read', false, 'Recherche TD. body.mode=api : un seul critère manufacturer, class, subclass ou tableau tdsynnexPartNumber/manufPartNumber/upcEan/customerPartNumber (50 max), page/pageSize (100 max). mode=browse : text, brands, classes, subclasses séparés par ;, minCost, maxCost, minStock, onlyInStock, notImported ; réutiliser scanCursor tant que hasMore. mode=cache : recherche paginée du catalogue chargé. Aucun import.'],
  ['catalogue_facets', 'POST', 'catalogue-facets', 'read', false, 'Facettes catégories/marques ; body.mode=cache et brands pour les comptages du cache.'],
  ['catalogue_index', 'GET', 'catalogue-index', 'read', false, 'État de l’ancien index (lecture uniquement).'],
  ['cache_status', 'GET', 'supplier-cache', 'read', false, 'Périmètres et progression du catalogue TD chargé.'],
  ['cache_action', 'POST', 'supplier-cache/{action}', 'import', true, 'Charge le cache TD : start avec body.brands séparées par ; ou fullCatalogue=true ; pause/resume avec body.id (64 caractères hex) ; tick traite une page. Ne crée pas de produit Shopware.'],
  ['icecat_preview', 'POST', 'icecat/preview', 'read', false, 'Aperçu Icecat pour body.partNumber TD : textes, caractéristiques et nombre d’images. Aucun enrichissement écrit.'],
  ['import', 'POST', 'import', 'import', true, 'Crée une tâche TD pour 1 à 500 parts. type=import crée des produits ; sync actualise les liés ; icecat enrichit textes/caractéristiques/photos ; icecat_missing cible les photos manquantes. Options figées depuis les paramètres enregistrés. Retourne un id, pas un résultat terminé.'],
  ['process', 'POST', 'process', 'import', true, 'Traite un lot de la file. Peut écrire des produits, prix, stocks, contenus et médias selon les tâches en attente.'],
  ['sync_preview', 'GET', 'sync-all', 'read', false, 'Prévisualise la synchronisation globale : nombre éligible et champs activés.'],
  ['sync_all', 'POST', 'sync-all', 'import', true, 'Programme la synchronisation de tous les produits liés actifs, tous fournisseurs. Lire sync_preview avant exécution.'],
  ['missing_preview', 'GET', 'icecat-missing', 'read', false, 'Compte les produits liés éligibles à Icecat pour photos manquantes.'],
  ['enrich_missing', 'POST', 'icecat-missing', 'import', true, 'Programme Icecat pour les produits liés sans photo, tous fournisseurs éligibles. Lire missing_preview avant exécution.'],
  ['workers', 'GET', 'workers', 'read', false, 'État des workers du plugin. Ne démarre pas de processus CLI.'],
  ['job_action', 'POST', 'jobs/{id}/{action}', 'import', true, 'Annule une tâche en attente (cancel) ou relance une tâche en erreur/annulée (retry).'],
  ['links', 'POST', 'links', 'import', true, 'Active/suspend le suivi TD pour partNumber avec enabled.'],
  ['list', 'GET', 'list/{kind}', 'read', false, 'Liste paginée (25 résultats) : kind=links, jobs ou logs. query.page et query.term (référence/nom, id tâche pour jobs, id tâche ou référence exacte pour logs).'],
  ['documents', 'POST', 'documents/{type}', 'documents', false, 'Lit les commandes ou factures TD : type=orders/invoices, body contient les filtres fournisseur.'],
  ['suppliers', 'GET', 'suppliers', 'read', false, 'Liste les fournisseurs et leur disponibilité.'],
  ['supplier_offers', 'POST', 'supplier-offers', 'read', false, 'Recherche Copaco chargé : supplier=copaco, term, page, brands, classes, minCost, maxCost, onlyInStock, notImported.'],
  ['feed_preview', 'POST', 'supplier-feed/preview', 'configure', false, 'Valide un CSV Copaco sans persister : body.supplier=copaco, csv, mapping, delimiter (défaut ;).'],
  ['feed_commit', 'POST', 'supplier-feed/commit', 'configure', true, 'Enregistre les offres CSV Copaco après aperçu, mêmes paramètres que feed_preview.'],
  ['supplier_bind', 'POST', 'supplier-bind', 'import', true, 'Lie une offre à un produit Shopware ou change son suivi : supplier, partNumber, productId facultatif/null, enabled.'],
  ['supplier_sync', 'POST', 'supplier-sync', 'import', true, 'Crée une tâche fournisseur : supplier=tdsynnex/copaco/ingram, parts (1 à 500), type=import/sync/icecat/icecat_missing. Pour enrichir une référence liée, choisir icecat. Suivre ensuite list kind=jobs/logs.'],
  ['reconcile', 'POST', 'reconcile-products', 'import', true, 'Réconcilie les liaisons du bridge avec les produits Shopware existants.'],
  ['copaco_settings', 'GET', 'copaco/settings', 'configure', false, 'Lit la configuration Copaco sans secrets.'],
  ['copaco_save_settings', 'POST', 'copaco/settings', 'configure', true, 'Enregistre les paramètres partiels de connexion/import Copaco.'],
  ['copaco_status', 'GET', 'copaco/status', 'read', false, 'État du téléchargement et cache Copaco.'],
  ['copaco_refresh', 'POST', 'copaco/refresh', 'configure', true, 'Demande le rafraîchissement du fichier catalogue Copaco. Suivre copaco_status.'],
  ['ingram_settings', 'GET', 'ingram/settings', 'configure', false, 'Lit la configuration Ingram sans secrets.'],
  ['ingram_save_settings', 'POST', 'ingram/settings', 'configure', true, 'Enregistre les paramètres partiels Ingram et son environnement sandbox/production.'],
  ['ingram_test', 'POST', 'ingram/test', 'configure', false, 'Teste la connexion Ingram sans écrire de produit.'],
  ['ingram_catalogue', 'POST', 'ingram/catalogue', 'read', false, 'Recherche Ingram sans persistance : text, brands, vendorPartNumbers séparés par ;, category, page, pageSize (100 max), type=IM::physical/digital/subscription/any, minCost, maxCost, minStock, onlyInStock.'],
  ['ingram_link', 'POST', 'ingram/link', 'import', true, 'Lie/délie une référence Ingram : partNumber, productId facultatif/null, enabled.'],
] as const;

function inputSchema(name: string, method: string, route: string, mutates: boolean): z.ZodRawShape {
  const schema: z.ZodRawShape = {};
  if (method === 'POST') schema.body = object.optional().describe('Objet JSON transmis au plugin ; voir la description de l’outil.');
  if (name === 'import' || name === 'supplier_sync') {
    schema.body = z.object({ parts, type: jobType.default(name === 'import' ? 'import' : 'sync'), ...(name === 'supplier_sync' ? { supplier } : {}) }).strict();
  }
  if (name === 'icecat_preview') schema.body = z.object({ partNumber: part }).strict();
  if (name === 'links') schema.body = z.object({ partNumber: part, enabled: z.boolean() }).strict();
  if (name === 'supplier_bind' || name === 'ingram_link') {
    schema.body = z.object({ partNumber: part, productId: uuid.nullable().optional(), enabled: z.boolean(), ...(name === 'supplier_bind' ? { supplier } : {}) }).strict();
  }
  if (route.includes('{action}')) schema.action = name === 'job_action' ? z.enum(['cancel', 'retry']) : z.enum(['start', 'pause', 'resume', 'tick']);
  if (route.includes('{id}')) schema.id = uuid;
  if (route.includes('{kind}')) {
    schema.kind = z.enum(['links', 'jobs', 'logs']);
    schema.query = z.object({ page: z.number().int().min(1).max(100000).optional(), term: z.string().max(200).optional() }).strict().optional();
  }
  if (name === 'diagnose_import') schema.query = z.object({ part: part.optional() }).strict().optional();
  if (route.includes('{type}')) schema.type = z.enum(['orders', 'invoices']);
  if (mutates) schema.confirm = z.boolean().default(false).describe('true pour autoriser cette modification.');
  return schema;
}

export function registerPartnerBridge(server: McpServer, api: (path: string, method?: string, body?: unknown) => Promise<unknown>) {
  server.tool('shopware_bridge_capabilities', 'Décrit toutes les fonctions LFINFO Partner Bridge 1.9.0, les droits nécessaires et le parcours d’enrichissement. Disponible même avant installation du plugin.', {}, async () => output({
    plugin: 'TDBridge', version: '1.9.0',
    requirements: 'Installer et activer le ZIP sur Shopware. Même SHOPWARE_URL et intégration OAuth que le MCP. ACL : td_bridge:read, td_bridge:import, td_bridge:configure, td_bridge:documents (ou intégration administrateur). Les droits restent vérifiés par Shopware.',
    workflow: ['Vérifier stats, suppliers et settings.', 'Rechercher dans catalogue / supplier_offers / ingram_catalogue.', 'Contrôler les paramètres TVA/devise et Icecat ; prévisualiser Icecat pour TD.', 'Importer ou enrichir les parts sélectionnées avec import ou supplier_sync, confirm=true.', 'Suivre list jobs/logs et workers. Les tâches sont asynchrones ; process traite un lot manuellement.', 'Pour compléter les photos existantes : missing_preview puis enrich_missing.'],
    unavailable: ['catalogue-index/{action} : désactivé par le plugin (409), utiliser catalogue et supplier-cache.', 'Les commandes CLI et l’installation du plugin nécessitent un accès au serveur Shopware ; aucune route HTTP dédiée.'],
    tools: bridgeEndpoints.map(([name, method, route, acl, mutates, description]) => ({ name: `shopware_bridge_${name}`, method, path: base + route, acl: `td_bridge:${acl}`, mutates, description }))
  }));
  for (const [name, method, route, acl, mutates, description] of bridgeEndpoints) {
    server.tool(`shopware_bridge_${name}`, `${description} Droit Shopware : td_bridge:${acl}.`, inputSchema(name, method, route, mutates), { readOnlyHint: !mutates, destructiveHint: mutates, openWorldHint: true }, async (args) => {
      if (mutates && args.confirm !== true) throw new Error('Cette opération modifie le bridge ou Shopware. Relancez avec confirm: true après validation.');
      let path = base + route.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(args[key])));
      if (args.query) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args.query as Record<string, unknown>)) if (value !== undefined) query.set(key, String(value));
        if (query.size) path += `?${query}`;
      }
      // POST is also used for read-only catalogue/document searches in this plugin.
      return output(await api(path, method, method === 'POST' ? args.body ?? {} : undefined));
    });
  }
}

function output(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
