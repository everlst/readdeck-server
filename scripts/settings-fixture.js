const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fixtureSource(sourcePath, options = {}) {
  return { id: options.id || 'fixture-source', name: options.name || '测试来源', path: sourcePath,
    enabled: true, order: 0, mode: 'auto', categoryId: '', watch: false, autoScrape: false, ...options };
}
// This fixture writer deliberately bypasses production validation to model offline roots and account states.
function prepareSettings({ dataRoot, libraryRoot, sources, categories = [], username = 'admin', password = 'test-password', watch = false, aiWebSearchEnabled = false } = {}) {
  const settings = {
    schemaVersion: 1, revision: 1, libraryConfirmed: true, scanRequired: false,
    sources: sources || [fixtureSource(libraryRoot, { watch })],
    categories: [{ id: 'comic', label: '漫画', visible: true, order: 0 }, { id: 'novel', label: '小说', visible: true, order: 1 }, { id: 'other', label: '其他', visible: true, order: 2 }, ...categories],
    scanning: { onStart: false, autoScrapeOnStart: false, usePolling: false, intervalMs: 1000 },
    metadata: { deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-v4-flash', aiWebSearchEnabled, matchEnabled: false, volumeMatchEnabled: false, localGroupEnabled: false },
    cache: { maxSizeMb: 150, maxResources: 120, ttlMinutes: 1440 },
  };
  const salt = crypto.randomBytes(16).toString('hex');
  const secretData = {
    schemaVersion: 1, account: { username, password: { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }, version: 1, mustChangePassword: false },
    signingKey: crypto.randomBytes(32).toString('hex'), deepseekApiKey: '', bangumiToken: '',
  };
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'config/settings.json'), JSON.stringify(settings), { mode: 0o600 });
  fs.writeFileSync(path.join(dataRoot, 'config/secrets.json'), JSON.stringify(secretData), { mode: 0o600 });
  return settings;
}
module.exports = { prepareSettings, fixtureSource };
