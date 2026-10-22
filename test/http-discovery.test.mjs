import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for (const mode of ['bearer', 'local-oauth']) {
test(`${mode}: discovery supports repeated and concurrent independent clients`, { timeout: 20000 }, async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let bearer = 'discovery-test-token-not-a-production-secret';
  const storage = await mkdtemp(join(tmpdir(), 'shopware-discovery-'));
  const publicUrl = 'https://mcp.example.test';
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env, MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_AUTH_MODE: mode, MCP_BEARER_TOKEN: bearer,
      MCP_PUBLIC_URL: publicUrl, OAUTH_ADMIN_USERNAME: 'test-admin', OAUTH_ADMIN_PASSWORD: 'test-password',
      OAUTH_SIGNING_SECRET: randomBytes(32).toString('hex'), OAUTH_STORAGE_PATH: join(storage, 'clients.json'), OAUTH_SCOPES: 'shopware:admin'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  const clients = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 5000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
      child.stderr.on('data', () => {
        if (logs.includes('/mcp')) { clearTimeout(timer); resolve(); }
      });
    });
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const unauthorized = await fetch(url, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    const health = await (await fetch(new URL('/healthz', url))).json();
    assert.equal(health.version, '0.1.1');
    if (mode === 'local-oauth') {
      assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);
      const metadata = await (await fetch(new URL('/.well-known/oauth-authorization-server', url))).json();
      assert.equal(metadata.issuer, publicUrl);
      const redirectUri = 'https://chatgpt.example.test/callback';
      const registration = await fetch(new URL('/oauth/register', url), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri] })
      });
      assert.equal(registration.status, 201);
      const { client_id: clientId } = await registration.json();
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL('/oauth/authorize', url);
      authorize.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state: 'regression', scope: 'shopware:admin',
        resource: publicUrl, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')
      });
      const loginPage = await (await fetch(authorize)).text();
      const loginId = loginPage.match(/name="login_id" value="([^"]+)"/)?.[1];
      assert.ok(loginId);
      const login = await fetch(new URL('/oauth/authorize', url), {
        method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ login_id: loginId, username: 'test-admin', password: 'test-password' })
      });
      assert.equal(login.status, 302);
      const callback = new URL(login.headers.get('location'));
      assert.equal(callback.searchParams.get('state'), 'regression');
      const tokens = await fetch(new URL('/oauth/token', url), {
        method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
          code: callback.searchParams.get('code'), code_verifier: verifier
        })
      });
      assert.equal(tokens.status, 200);
      bearer = (await tokens.json()).access_token;
      assert.ok(bearer);
    }
    async function discover() {
      const client = new Client({ name: 'discovery-regression', version: '1.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
      }));
      for (let attempt = 0; attempt < 2; attempt++) {
        const listing = await client.listTools();
        assert.ok(listing.tools.some(tool => tool.name === 'shopware_update_product'));
        assert.ok(listing.tools.some(tool => tool.name === 'shopware_search'));
        assert.ok(listing.tools.every(tool => tool.inputSchema.type === 'object'));
      }
    }
    await discover();
    await discover();
    await Promise.all([discover(), discover(), discover()]);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    await rm(storage, { recursive: true, force: true });
  }
});
}
