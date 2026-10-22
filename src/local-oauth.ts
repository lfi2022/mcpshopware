import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jwtVerify, SignJWT } from 'jose';

type RegisteredClient = { clientId: string; redirectUris: string[]; clientName?: string };
type AuthorizationCode = { clientId: string; redirectUri: string; codeChallenge: string; scope: string; expiresAt: number };
type LoginRequest = { clientId: string; redirectUri: string; state: string; codeChallenge: string; scope: string; resource?: string; expiresAt: number };

const encoder = new TextEncoder();
const html = (content: string) => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autoriser Shopware MCP</title><style>body{font:16px system-ui;max-width:32rem;margin:10vh auto;padding:1rem;color:#18212f}input,button{box-sizing:border-box;width:100%;padding:.7rem;margin:.35rem 0}button{background:#087ea4;color:white;border:0;border-radius:.3rem;font-weight:600}small{color:#5b6778}</style>${content}</html>`;

export class LocalOAuthProvider {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly logins = new Map<string, LoginRequest>();
  private readonly key: Uint8Array;

  constructor(private readonly options: { publicUrl: string; adminUsername: string; adminPassword: string; signingSecret: string; storagePath: string; scopes: string[] }) {
    if (options.signingSecret.length < 32) throw new Error('OAUTH_SIGNING_SECRET doit contenir au moins 32 caractères aléatoires.');
    this.key = encoder.encode(options.signingSecret);
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.options.storagePath, 'utf8')) as RegisteredClient[];
      for (const client of saved) if (client.clientId && Array.isArray(client.redirectUris)) this.clients.set(client.clientId, client);
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (path === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return this.json(response, 200, {
        issuer: this.options.publicUrl,
        authorization_endpoint: `${this.options.publicUrl}/oauth/authorize`,
        token_endpoint: `${this.options.publicUrl}/oauth/token`,
        registration_endpoint: `${this.options.publicUrl}/oauth/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
        scopes_supported: this.options.scopes
      });
    }
    if (path === '/oauth/register' && request.method === 'POST') return this.register(request, response);
    if (path === '/oauth/authorize' && request.method === 'GET') return this.authorizePage(request, response);
    if (path === '/oauth/authorize' && request.method === 'POST') return this.authorize(request, response);
    if (path === '/oauth/token' && request.method === 'POST') return this.token(request, response);
    return false;
  }

  async verify(authorization: string | undefined): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.key, { issuer: this.options.publicUrl, audience: this.options.publicUrl });
      if (payload.token_use === 'refresh') return false;
      const tokenScopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      return this.options.scopes.every(scope => tokenScopes.includes(scope));
    } catch { return false; }
  }

  private async register(request: IncomingMessage, response: ServerResponse) {
    const body = await this.readJson(request) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && this.isSafeRedirect(uri)) : [];
    if (!redirectUris.length) return this.oauthError(response, 400, 'invalid_client_metadata', 'redirect_uris HTTPS requis.');
    const client: RegisteredClient = { clientId: this.id(), redirectUris, clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined };
    this.clients.set(client.clientId, client);
    await this.persistClients();
    return this.json(response, 201, { client_id: client.clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: client.redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }

  private authorizePage(request: IncomingMessage, response: ServerResponse) {
    const params = new URL(request.url ?? '', this.options.publicUrl).searchParams;
    const validated = this.validateAuthorization(params);
    if (typeof validated === 'string') return this.oauthError(response, 400, 'invalid_request', validated);
    const loginId = this.id();
    this.logins.set(loginId, { ...validated, expiresAt: Date.now() + 5 * 60_000 });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html(`<main><h1>Shopware MCP</h1><p>Connecter ChatGPT avec le compte administrateur local.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="login_id" value="${loginId}"><label>Utilisateur<input name="username" autocomplete="username" required></label><label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Autoriser ChatGPT</button></form><small>Client : ${validated.clientId}</small></main>`));
    return true;
  }

  private async authorize(request: IncomingMessage, response: ServerResponse) {
    const form = new URLSearchParams(await this.readText(request));
    const login = this.logins.get(form.get('login_id') ?? '');
    if (!login || login.expiresAt < Date.now()) return this.oauthError(response, 400, 'invalid_request', 'Session de connexion expirée.');
    this.logins.delete(form.get('login_id')!);
    const username = form.get('username') ?? '';
    const password = form.get('password') ?? '';
    if (!this.equal(username, this.options.adminUsername) || !this.equal(password, this.options.adminPassword)) return this.oauthError(response, 401, 'access_denied', 'Identifiants invalides.');
    const code = this.id();
    this.codes.set(code, { clientId: login.clientId, redirectUri: login.redirectUri, codeChallenge: login.codeChallenge, scope: login.scope, expiresAt: Date.now() + 5 * 60_000 });
    const redirect = new URL(login.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', login.state);
    response.writeHead(302, { location: redirect.toString(), 'cache-control': 'no-store' }).end();
    return true;
  }

  private async token(request: IncomingMessage, response: ServerResponse) {
    const form = new URLSearchParams(await this.readText(request));
    if (form.get('grant_type') === 'refresh_token') return this.refreshToken(form, response);
    const code = this.codes.get(form.get('code') ?? '');
    if (!code || code.expiresAt < Date.now() || code.clientId !== form.get('client_id') || code.redirectUri !== form.get('redirect_uri')) return this.oauthError(response, 400, 'invalid_grant', 'Code invalide ou expiré.');
    this.codes.delete(form.get('code')!);
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!this.equal(challenge, code.codeChallenge)) return this.oauthError(response, 400, 'invalid_grant', 'Vérification PKCE échouée.');
    return this.issueTokens(response, code.scope, code.clientId);
  }

  private async refreshToken(form: URLSearchParams, response: ServerResponse) {
    try {
      const { payload } = await jwtVerify(form.get('refresh_token') ?? '', this.key, { issuer: this.options.publicUrl, audience: this.options.publicUrl });
      if (payload.token_use !== 'refresh' || typeof payload.scope !== 'string' || typeof payload.client_id !== 'string' || payload.client_id !== form.get('client_id')) throw new Error('invalid');
      return this.issueTokens(response, payload.scope, payload.client_id);
    } catch { return this.oauthError(response, 400, 'invalid_grant', 'Refresh token invalide ou expiré.'); }
  }

  private async issueTokens(response: ServerResponse, scope: string, clientId: string) {
    const claims = { scope, client_id: clientId, sub: this.options.adminUsername };
    const accessToken = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(this.options.publicUrl).setAudience(this.options.publicUrl).setIssuedAt().setExpirationTime('1h').sign(this.key);
    const refreshToken = await new SignJWT({ ...claims, token_use: 'refresh' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(this.options.publicUrl).setAudience(this.options.publicUrl).setIssuedAt().setExpirationTime('30d').sign(this.key);
    return this.json(response, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken, scope });
  }

  private validateAuthorization(params: URLSearchParams): Omit<LoginRequest, 'expiresAt'> | string {
    const clientId = params.get('client_id') ?? '';
    const client = this.clients.get(clientId);
    const redirectUri = params.get('redirect_uri') ?? '';
    const requested = (params.get('scope') ?? '').split(' ').filter(Boolean);
    const resource = params.get('resource') ?? undefined;
    if (params.get('response_type') !== 'code' || !client || !client.redirectUris.includes(redirectUri) || !params.get('state')) return 'Client, redirection ou état invalide.';
    if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) return 'PKCE S256 est requis.';
    if (!requested.length || requested.some(scope => !this.options.scopes.includes(scope))) return 'Scope non autorisé.';
    if (resource && resource !== this.options.publicUrl) return 'Resource OAuth invalide.';
    return { clientId, redirectUri, state: params.get('state')!, codeChallenge: params.get('code_challenge')!, scope: requested.join(' '), resource };
  }

  private async persistClients() {
    await mkdir(dirname(this.options.storagePath), { recursive: true });
    const temporary = `${this.options.storagePath}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.clients.values()]), { mode: 0o600 });
    await rename(temporary, this.options.storagePath);
  }
  private isSafeRedirect(uri: string) { try { return new URL(uri).protocol === 'https:'; } catch { return false; } }
  private id() { return randomBytes(32).toString('base64url'); }
  private equal(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
  private async readText(request: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > 64_000) throw new Error('Requête trop volumineuse.'); chunks.push(value); } return Buffer.concat(chunks).toString('utf8'); }
  private async readJson(request: IncomingMessage) { try { return JSON.parse(await this.readText(request)) as unknown; } catch { return {}; } }
  private json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body)); return true; }
  private oauthError(response: ServerResponse, status: number, error: string, description: string) { return this.json(response, status, { error, error_description: description }); }
}
