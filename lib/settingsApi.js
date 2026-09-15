const store = require('./settingsStore');
const auth = require('./auth');
const users = require('./userStore');
const ai = require('./aiProvider');
const debug = require('./debugLog');

function installSettingsApi(app, { watcher, cleanupCache }) {
  const route = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requestId = debug.requestId(), started = Date.now();
    res.set('X-ReadDeck-Request-Id', requestId);
    const secrets = debug.secretValues(req.body);
    try { secrets.push(...debug.secretValues(store.secrets())); } catch { /* The route reports unreadable settings below. */ }
    return debug.withContext(requestId, secrets, async () => {
      debug.log('settings.request', { method: req.method, path: req.path, body: req.body });
      try { await fn(req, res); }
      catch (error) {
        debug.log('settings.error', { method: req.method, path: req.path, elapsedMs: Date.now() - started, error });
        if (!debug.isEnabled()) console.warn('[settings] ' + JSON.stringify({ requestId, path: req.path,
          status: error.status || 500, reason: debug.sanitize(error.status ? error.message : error.name, secrets) }));
        const message = error.status ? debug.sanitize(error.message, secrets) : '操作失败，请检查服务器日志中的请求编号';
        res.status(error.status || 500).json({ error: message + '（请求编号：' + requestId + '）', requestId });
      } finally {
        debug.log('settings.completed', { method: req.method, path: req.path, status: res.statusCode, elapsedMs: Date.now() - started });
      }
    });
  };
  app.get('/api/settings', route(async (req, res) => res.json({ ...(await store.publicSettings()), watcher: watcher.status() })));
  app.put('/api/settings', route(async (req, res) => {
    const saved = await store.save(req.body || {});
    await watcher.rebuild().catch(() => {});
    res.json({ ...saved, watcher: watcher.status() });
  }));
  app.get('/api/settings/discovered-sources', route(async (req, res) => {
    res.json({ sources: await store.discoverSources() });
  }));
  app.put('/api/account', route(async (req, res) => {
    const account = await users.updateAccount(req.user.id, req.body || {});
    res.json({ ...account, token: auth.createToken(users.get(req.user.id)) });
  }));
  app.post('/api/settings/cache/clear', route(async (req, res) => {
    await cleanupCache({ clearAll: true });
    res.json({ success: true, message: '已清理未使用的缓存，近期活跃阅读资源继续保留' });
  }));
  app.post('/api/settings/ai/models', route(async (req, res) => {
    const connection = ai.connection(req.body || {}, store.snapshot(), store.secrets());
    res.json(await ai.listModels(connection, { refresh: true }));
  }));
  app.post('/api/settings/test/ai', route(async (req, res) => {
    const connection = ai.connection(req.body || {}, store.snapshot(), store.secrets());
    const model = req.body?.model ?? store.snapshot().metadata.aiModel;
    const effort = req.body?.effort ?? store.snapshot().metadata.aiReasoningEffort;
    await ai.validateSelection(connection, model, effort);
    await ai.complete({ messages: [{ role: 'user', content: 'Reply with only the word OK.' }] }, { ...connection, model, effort, timeout: 20000, concurrency: store.snapshot().metadata.aiConcurrency });
    res.json({ success: true, message: '模型调用成功，当前思考程度可用' });
  }));
  app.post('/api/settings/test/ai-search', route(async (req, res) => {
    const settings = store.snapshot();
    const connection = ai.connection(req.body || {}, settings, store.secrets());
    const model = req.body?.model ?? settings.metadata.aiModel;
    const effort = req.body?.effort ?? settings.metadata.aiReasoningEffort;
    await ai.validateSelection(connection, model, effort);
    res.json(await ai.testWebSearch({ ...connection, model, effort, timeout: 120000, concurrency: settings.metadata.aiConcurrency }));
  }));
  for (const provider of ['deepseek', 'bangumi']) {
    app.post('/api/settings/test/' + provider, route(async (req, res) => {
      const settings = store.snapshot();
      const credentials = store.secrets();
      const isDeepseek = provider === 'deepseek';
      const aiConnection = isDeepseek ? ai.connection(req.body || {}, settings, credentials) : null;
      const key = isDeepseek ? aiConnection.apiKey : (req.body?.apiKey || credentials.bangumiToken);
      if (typeof key !== 'string' || /[\r\n]/.test(key) || key.length > 4096) return res.status(400).json({ error: '密钥格式无效' });
      const base = isDeepseek ? aiConnection.baseUrl : 'https://api.bgm.tv';
      const endpoint = isDeepseek ? base + '/models' : (key ? base + '/v0/me' : base + '/v0/subjects/1');
      let response;
      try {
        response = await fetch(endpoint, {
          headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'User-Agent': 'reader-plus/2.1 (+https://bangumi.tv)' },
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
      } catch { return res.status(502).json({ error: '连接失败或超时，请检查接口地址与网络' }); }
      await response.body?.cancel();
      if (!response.ok) return res.status(502).json({ error: '服务返回 HTTP ' + response.status + '，请检查密钥和接口权限' });
      res.json({ success: true, message: '连接成功' });
    }));
  }
}
module.exports = { installSettingsApi };
