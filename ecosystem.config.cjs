module.exports = {
  apps: [{
    name: 'shopware6-admin-mcp',
    script: 'dist/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    env: {
      NODE_ENV: 'production',
      MCP_TRANSPORT: 'http',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '3000',
      // En production ChatGPT, utilisez plutôt : MCP_AUTH_MODE=oauth.
      MCP_AUTH_MODE: 'bearer'
      // Définissez SHOPWARE_URL, SHOPWARE_CLIENT_ID, SHOPWARE_CLIENT_SECRET
      // et MCP_BEARER_TOKEN dans l’environnement du serveur, jamais ici.
    }
  }]
};
