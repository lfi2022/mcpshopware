import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bridgeEndpoints, registerPartnerBridge } from '../dist/partner-bridge.js';

const uuid = 'a'.repeat(32);
const prefix = '/api/_action/td-bridge/';
const parse = result => JSON.parse(result.content[0].text);

test('covers every controller route in the supplied 1.9.0 ZIP except its disabled index action', async () => {
  // Extracted from all three PHP controllers in the original archive.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/partner-bridge-1.9.0-routes.json', import.meta.url), 'utf8'));
  const actual = bridgeEndpoints.map(([, method, route]) => `${method} ${prefix}${route}`).sort();
  const expected = fixture.filter(route => route.path !== `${prefix}catalogue-index/{action}`)
    .flatMap(route => route.path === `${prefix}supplier-feed/{action}`
      ? ['preview', 'commit'].map(action => `${route.method} ${prefix}supplier-feed/${action}`)
      : [`${route.method} ${route.path}`]).sort();
  assert.deepEqual(actual, expected);
});

test('all bridge tools execute through MCP with the expected route, method, body and confirmation', async () => {
  const server = new McpServer({ name: 'bridge-test', version: '1' });
  const calls = [];
  let fail = false;
  registerPartnerBridge(server, async (path, method, body) => {
    calls.push({ path, method, body });
    if (fail) throw new Error('Shopware API 403: droits td_bridge:import manquants');
    return { path, method, body, id: uuid };
  });
  const client = new Client({ name: 'bridge-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listing = await client.listTools();
    assert.equal(listing.tools.length, bridgeEndpoints.length + 1);
    const capabilities = parse(await client.callTool({ name: 'shopware_bridge_capabilities', arguments: {} }));
    assert.equal(capabilities.tools.length, bridgeEndpoints.length);
    assert.equal(calls.length, 0);
    for (const [name, method, route, , mutates] of bridgeEndpoints) {
      const args = {};
      if (method === 'POST') args.body = { sample: 'transmitted unchanged' };
      if (name === 'import' || name === 'supplier_sync') args.body = { parts: ['PART-1'], type: 'icecat', ...(name === 'supplier_sync' ? { supplier: 'ingram' } : {}) };
      if (name === 'links' || name === 'supplier_bind' || name === 'ingram_link') args.body = { partNumber: 'PART-1', enabled: true, ...(name === 'links' ? {} : { productId: uuid }), ...(name === 'supplier_bind' ? { supplier: 'copaco' } : {}) };
      if (name === 'icecat_preview') args.body = { partNumber: 'PART-1' };
      if (route.includes('{action}')) args.action = name === 'job_action' ? 'retry' : 'start';
      if (route.includes('{id}')) args.id = uuid;
      if (route.includes('{kind}')) { args.kind = 'logs'; args.query = { page: 2, term: 'REF & é?/#' }; }
      if (name === 'diagnose_import') args.query = { part: 'REF & é?/#' };
      if (route.includes('{type}')) args.type = 'invoices';
      const toolName = `shopware_bridge_${name}`;
      assert.equal(listing.tools.find(tool => tool.name === toolName).annotations.readOnlyHint, !mutates);
      if (mutates) {
        const before = calls.length;
        const denied = await client.callTool({ name: toolName, arguments: args });
        assert.equal(denied.isError, true, name);
        assert.equal(calls.length, before, 'no API call without confirmation');
        args.confirm = true;
      }
      const response = await client.callTool({ name: toolName, arguments: args });
      assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
      const expectedPath = prefix + route.replace(/\{(\w+)\}/g, (_, key) => args[key]);
      const actual = calls.at(-1);
      const url = new URL(actual.path, 'https://shop.test');
      assert.equal(url.pathname, expectedPath, name);
      for (const [key, value] of Object.entries(args.query ?? {})) assert.equal(url.searchParams.get(key), String(value));
      assert.equal(actual.method, method);
      assert.deepEqual(actual.body, method === 'POST' ? args.body : undefined);
      assert.equal(parse(response).id, uuid);
    }
    for (const body of [{ parts: [], type: 'icecat' }, { parts: Array(501).fill('P'), type: 'import' }, { parts: ['P'], type: 'invalid' }]) {
      const before = calls.length;
      const response = await client.callTool({ name: 'shopware_bridge_import', arguments: { body, confirm: true } });
      assert.equal(response.isError, true);
      assert.equal(calls.length, before);
    }
    const invalid = await client.callTool({ name: 'shopware_bridge_job_action', arguments: { id: '../oauth', action: 'retry', confirm: true } });
    assert.equal(invalid.isError, true);
    fail = true;
    const error = await client.callTool({ name: 'shopware_bridge_stats', arguments: {} });
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /403/);
  } finally {
    await client.close();
    await server.close();
  }
});
