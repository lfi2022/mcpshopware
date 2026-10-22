module.exports = {
  apps: [{
    name: 'shopware6-admin-mcp',
    script: 'dist/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    env: {
      NODE_ENV: 'production'
      // Toutes les variables MCP et Shopware sont lues depuis .env,
      // jamais depuis ce fichier versionné.
    }
  }]
};
