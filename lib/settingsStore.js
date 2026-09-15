const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const paths = require('./runtimePaths');
const ai = require('./aiProvider');
const debug = require('./debugLog');
const scrypt = promisify(crypto.scrypt);
const SETTINGS_FILE = path.join(paths.CONFIG_DIR, 'settings.json');
const SECRETS_FILE = path.join(paths.CONFIG_DIR, 'secrets.json');
const BUILTIN_CATEGORIES = ['comic', 'novel', 'other'];
const listeners = new Set();
let operationChain = Promise.resolve();
let initializing;
let topologyBusy = () => false;
let applying = false;

function defaults() {
  return {
    schemaVersion: 1, revision: 0, libraryConfirmed: false, scanRequired: false,
    sources: [],
    categories: ['漫画', '小说', '其他'].map((label, order) => ({
      id: BUILTIN_CATEGORIES[order], label, visible: true, order,
    })),
    scanning: { onStart: true, autoScrapeOnStart: true, usePolling: false, intervalMs: 5000, scrapeConcurrency: 4 },
    metadata: {
      aiBaseUrl: 'https://api.openai.com/v1', aiModel: '', aiReasoningEffort: '', aiConcurrency: 4,
      aiWebSearchEnabled: true, matchEnabled: true, volumeMatchEnabled: true, localGroupEnabled: true,
    },
    cache: { maxSizeMb: 150, maxResources: 120, ttlMinutes: 1440 },
    diagnostics: { debugEnabled: false },
  };
}

function readStrict(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('无法读取配置 ' + path.basename(file) + '，请从备份恢复：' + (error.code || 'JSON 格式错误'));
  }
}
let current = readStrict(SETTINGS_FILE, defaults());
if (current.schemaVersion !== 1) throw new Error('不支持的 settings.json 版本');
// Preserve existing capacities within the supported range when loading older settings.
current.cache.maxSizeMb = Math.min(4096, Math.max(64, current.cache.maxSizeMb ?? 150));
// Upgrade persisted DeepSeek settings without changing the configured service or credentials.
function migrateMetadata(metadata) {
  const { deepseekBaseUrl, deepseekModel, ...rest } = metadata;
  return { ...rest, aiBaseUrl: ai.normalizeBaseUrl(rest.aiBaseUrl ?? deepseekBaseUrl ?? defaults().metadata.aiBaseUrl),
    aiModel: rest.aiModel ?? deepseekModel ?? '', aiReasoningEffort: rest.aiReasoningEffort ?? '', aiConcurrency: rest.aiConcurrency ?? 4,
    aiWebSearchEnabled: rest.aiWebSearchEnabled ?? true };
}
current.metadata = migrateMetadata(current.metadata);
current.scanning.scrapeConcurrency ??= 4;
current.diagnostics = { debugEnabled: current.diagnostics?.debugEnabled === true };
debug.setEnabled(current.diagnostics.debugEnabled);
debug.log('settings.loaded', current);
function snapshot() { return structuredClone(current); }
function secrets() {
  const { deepseekApiKey, ...rest } = readStrict(SECRETS_FILE, {});
  return { ...rest, aiApiKey: rest.aiApiKey ?? deepseekApiKey ?? '' };
}
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function contains(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
async function atomicWrite(file, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const handle = await fsp.open(temp, 'wx', mode);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await fsp.rename(temp, file);
  } finally { await fsp.unlink(temp).catch(() => {}); }
}
function serialize(operation) {
  const next = operationChain.then(operation, operation);
  operationChain = next.catch(() => {});
  return next;
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString('hex') };
}
async function checkPassword(password, record) {
  if (typeof password !== 'string' || password.length > 1024 || !record?.salt || !record?.hash) return false;
  const actual = await scrypt(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function normalizePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim()) || value.includes('\0')) fail('来源路径必须是容器内的绝对目录');
  const result = path.resolve(value.trim());
  const forbidden = [paths.DATA_DIR, ...['lib', 'public', 'scripts', 'node_modules', '.git'].map(p => path.join(paths.ROOT_DIR, p))];
  if (result === path.parse(result).root || result === '/app' || result === paths.ROOT_DIR || result === paths.LIBRARY_DIR ||
      forbidden.some(root => contains(root, result) || contains(result, root))) fail('不能将系统、应用代码或数据目录作为书库来源');
  return result;
}
async function sourceStatus(source) {
  try {
    const realPath = await fsp.realpath(source.path);
    normalizePath(realPath);
    if (!(await fsp.stat(realPath)).isDirectory()) throw new Error('路径不是目录');
    await fsp.access(realPath, fs.constants.R_OK | fs.constants.X_OK);
    return { id: source.id, available: true, realPath };
  } catch (error) {
    return { id: source.id, available: false, warning: error.status ? error.message : '路径不存在或不可访问' };
  }
}
async function discoverSources() {
  const entries = await fsp.readdir(paths.LIBRARY_DIR, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['@eaDir', '#recycle'].includes(entry.name)) continue;
    const target = path.join(paths.LIBRARY_DIR, entry.name);
    if (current.sources.some(s => contains(s.path, target) || contains(target, s.path))) continue;
    const source = {
      id: 'source-' + crypto.randomUUID(), name: entry.name, path: target, enabled: true,
      order: current.sources.length + found.length, mode: 'auto', categoryId: '', watch: true, autoScrape: true,
    };
    if ((await sourceStatus(source)).available) found.push(source);
  }
  return found;
}
async function initialize() {
  if (initializing) return initializing;
  initializing = serialize(async () => {
    if (!fs.existsSync(SECRETS_FILE)) {
      await atomicWrite(SECRETS_FILE, {
        schemaVersion: 1,
        account: { username: 'admin', password: await hashPassword('admin'), version: 1, mustChangePassword: true },
        signingKey: crypto.randomBytes(32).toString('hex'), aiApiKey: '', bangumiToken: '',
      });
    }
    await fsp.chmod(SECRETS_FILE, 0o600);
    if (!fs.existsSync(SETTINGS_FILE)) {
      current = { ...defaults(), sources: await discoverSources(), revision: 1 };
      await atomicWrite(SETTINGS_FILE, current);
    }
    const deprecated = Object.keys(process.env).filter(name => /^(?:LIBRARY_|COMICS_DIR$|OTHER_|CUSTOM_LIBRARY_|ADMIN_|JWT_SECRET$|AUTO_SCRAPE_|DEEPSEEK_|BANGUMI_|READER_CACHE_|IMAGE_MAX_|PDF_RENDER_|PRELOAD_PAGE_|ARCHIVE_|SCAN_LIBRARY_|SCRAPE_SERIES_)/.test(name));
    if (deprecated.length) console.warn('[settings] 旧业务环境变量已停用，请在系统设置中配置：' + deprecated.join(', '));
    return snapshot();
  });
  return initializing;
}
function text(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(label + '不能为空且不能超过 ' + max + ' 个字符');
  return value.trim();
}
function bool(value, label) { if (typeof value !== 'boolean') fail(label + '必须为开关值'); return value; }
function number(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(label + '必须为 ' + min + '–' + max + ' 之间的整数');
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('无效的来源或栏目 ID');
  return value;
}
const normalizeBaseUrl = ai.normalizeBaseUrl;
function topology(settings) {
  return JSON.stringify(settings.sources.map(s => ({ id: s.id, path: s.path, enabled: s.enabled, mode: s.mode, categoryId: s.categoryId })).sort((a, b) => a.id.localeCompare(b.id)));
}
async function validate(input) {
  if (!Array.isArray(input.categories) || !Array.isArray(input.sources) || input.sources.length > 200 || input.categories.length > 100) fail('来源或栏目列表无效');
  const categories = input.categories.map((c, order) => ({ id: identifier(c.id), label: text(c.label, '栏目名称', 48), visible: bool(c.visible, '栏目显示'), order }));
  const categoryIds = new Set(categories.map(c => c.id));
  if (categoryIds.size !== categories.length || BUILTIN_CATEGORIES.some(id => !categoryIds.has(id))) fail('默认栏目不可删除，栏目 ID 不可重复');
  if (!categories.some(c => c.visible)) fail('至少保留一个可见栏目');
  const sources = input.sources.map((s, order) => {
    if (!['auto', 'fixed'].includes(s.mode)) fail('归类方式无效');
    const categoryId = s.mode === 'fixed' ? identifier(s.categoryId) : '';
    if (categoryId && !categoryIds.has(categoryId)) fail('请先解除来源对已删除栏目的引用');
    return { id: identifier(s.id), name: text(s.name, '来源名称'), path: normalizePath(s.path), enabled: bool(s.enabled, '来源启用'), order,
      mode: s.mode, categoryId, watch: bool(s.watch, '监听'), autoScrape: bool(s.autoScrape, '自动刮削') };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length) fail('来源 ID 不可重复');
  const statuses = await Promise.all(sources.map(sourceStatus));
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const previous = current.sources.find(s => s.id === source.id);
    if (!statuses[i].available && (!previous || previous.path !== source.path)) fail(source.name + '：' + statuses[i].warning);
    for (let j = 0; j < i; j++) {
      if (contains(source.path, sources[j].path) || contains(sources[j].path, source.path) ||
          (statuses[i].realPath && statuses[j].realPath && (contains(statuses[i].realPath, statuses[j].realPath) || contains(statuses[j].realPath, statuses[i].realPath)))) fail('来源目录不可重复或相互嵌套');
    }
  }
  const scan = input.scanning || {};
  const meta = migrateMetadata(input.metadata || {});
  if (typeof meta.aiModel !== 'string' || meta.aiModel.length > 200) fail('模型名称无效');
  if (meta.aiReasoningEffort !== '' && !ai.EFFORTS.includes(meta.aiReasoningEffort)) fail('思考程度无效');
  const cache = input.cache || {};
  return {
    settings: {
      schemaVersion: 1, revision: current.revision + 1, libraryConfirmed: true,
      scanRequired: current.scanRequired, sources, categories,
      scanning: { onStart: bool(scan.onStart, '启动扫描'), autoScrapeOnStart: bool(scan.autoScrapeOnStart, '启动自动刮削'), usePolling: bool(scan.usePolling, '轮询监听'), intervalMs: number(scan.intervalMs, '轮询间隔', 1000, 3600000), scrapeConcurrency: number(scan.scrapeConcurrency ?? 4, '作品刮削并发数', 1, 8) },
      metadata: { aiBaseUrl: normalizeBaseUrl(meta.aiBaseUrl), aiModel: meta.aiModel.trim(), aiReasoningEffort: meta.aiReasoningEffort, aiConcurrency: number(meta.aiConcurrency, 'AI 请求并发数', 1, 12),
        // Older clients omit this field; preserve the server's current choice.
        aiWebSearchEnabled: bool(input.metadata?.aiWebSearchEnabled === undefined ? current.metadata.aiWebSearchEnabled : input.metadata.aiWebSearchEnabled, '联网搜索'),
        matchEnabled: bool(meta.matchEnabled, '系列匹配'), volumeMatchEnabled: bool(meta.volumeMatchEnabled, '卷册匹配'), localGroupEnabled: bool(meta.localGroupEnabled, '智能分组') },
      cache: { maxSizeMb: number(cache.maxSizeMb, '缓存容量', 64, 4096), maxResources: number(cache.maxResources, '缓存资源数', 1, 100000), ttlMinutes: number(cache.ttlMinutes, '缓存保留时间', 1, 525600) },
      diagnostics: { debugEnabled: bool(input.diagnostics?.debugEnabled === undefined ? current.diagnostics.debugEnabled : input.diagnostics.debugEnabled, '调试模式') },
    },
    warnings: statuses.filter(s => !s.available).map(s => ({ sourceId: s.id, message: s.warning })),
  };
}
function changed(reason) {
  if (reason === 'settings_saved') ai.setConcurrency(current.metadata.aiConcurrency);
  for (const listener of listeners) {
    try { listener({ reason, revision: current.revision }); } catch (error) { console.warn('[settings] 通知失败:', error.message); }
  }
}
async function save(input) {
  return serialize(async () => {
    if (input.revision !== current.revision) fail('设置已被其他页面修改，请重新载入后再保存', 409);
    const { settings: next, warnings } = await validate(input);
    const topologyChanged = topology(next) !== topology(current);
    if (topologyChanged && topologyBusy()) fail('扫描或刮削任务正在执行，请完成后再修改来源路径、启用状态或归类方式', 409);
    applying = true;
    const previousSecrets = secrets();
    try {
      const nextSecrets = { ...previousSecrets };
      for (const key of ['aiApiKey', 'bangumiToken']) {
        const value = input.credentials?.[key] ?? (key === 'aiApiKey' ? input.credentials?.deepseekApiKey : undefined);
        if (input.credentials?.['clear' + key[0].toUpperCase() + key.slice(1)] === true || (key === 'aiApiKey' && input.credentials?.clearDeepseekApiKey === true)) nextSecrets[key] = '';
        else if (value !== undefined && value !== '') {
          if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) fail('密钥格式无效');
          nextSecrets[key] = value.trim();
        }
      }
      const aiChanged = ['aiBaseUrl', 'aiModel', 'aiReasoningEffort'].some(key => next.metadata[key] !== current.metadata[key]) || nextSecrets.aiApiKey !== previousSecrets.aiApiKey;
      if (nextSecrets.aiApiKey && next.metadata.aiBaseUrl !== current.metadata.aiBaseUrl && !input.credentials?.aiApiKey?.trim() && !input.credentials?.deepseekApiKey?.trim()) fail('更换接口地址后，请重新输入 API Key');
      if (aiChanged && nextSecrets.aiApiKey) await ai.validateSelection({ baseUrl: next.metadata.aiBaseUrl, apiKey: nextSecrets.aiApiKey }, next.metadata.aiModel, next.metadata.aiReasoningEffort);
      next.scanRequired = next.scanRequired || topologyChanged || !current.libraryConfirmed;
      await atomicWrite(SECRETS_FILE, nextSecrets);
      try { await atomicWrite(SETTINGS_FILE, next); }
      catch (error) { await atomicWrite(SECRETS_FILE, previousSecrets); throw error; }
      current = next;
      debug.log('settings.saved', { settings: current, debugEnabled: current.diagnostics.debugEnabled });
      const wasDebug = debug.isEnabled();
      debug.setEnabled(current.diagnostics.debugEnabled);
      if (!wasDebug) debug.log('settings.saved', { settings: current, debugEnabled: true });
      changed('settings_saved');
      return { ...(await publicSettings()), warnings, scanRequired: next.scanRequired };
    } finally { applying = false; }
  });
}
async function publicSettings() {
  const result = snapshot();
  const privateData = secrets();
  result.sourceStatus = (await Promise.all(result.sources.map(sourceStatus))).map(({ realPath, ...status }) => status);
  result.credentials = { aiApiKeyConfigured: !!privateData.aiApiKey, bangumiTokenConfigured: !!privateData.bangumiToken };
  result.account = { username: privateData.account?.username || 'admin', mustChangePassword: privateData.account?.mustChangePassword !== false };
  result.discoveryRoot = paths.LIBRARY_DIR;
  return result;
}
async function updateAccount({ currentPassword, username, password }) {
  return serialize(async () => {
    const privateData = secrets();
    if (!(await checkPassword(currentPassword, privateData.account?.password))) fail('当前密码错误', 403);
    const nextName = text(username, '用户名', 64);
    if (typeof password !== 'string' || password.length < 8 || password.length > 1024 || password === 'admin') fail('新密码需为 8–1024 个字符');
    if (await checkPassword(password, privateData.account.password)) fail('新密码不能与当前密码相同');
    privateData.account = { username: nextName, password: await hashPassword(password), version: privateData.account.version + 1, mustChangePassword: false };
    await atomicWrite(SECRETS_FILE, privateData);
    changed('account_changed');
    return { username: nextName, mustChangePassword: false };
  });
}
async function resetAccount() {
  await initialize();
  return serialize(async () => {
    const privateData = secrets();
    privateData.account = { username: 'admin', password: await hashPassword('admin'), version: (privateData.account?.version || 0) + 1, mustChangePassword: true };
    await atomicWrite(SECRETS_FILE, privateData);
  });
}
async function markScanned() {
  return serialize(async () => {
    if (!current.scanRequired) return;
    const next = { ...current, scanRequired: false, revision: current.revision + 1 };
    await atomicWrite(SETTINGS_FILE, next);
    current = next;
    changed('scan_applied');
  });
}
module.exports = {
  defaults, initialize, snapshot, secrets, save, publicSettings, discoverSources, sourceStatus,
  updateAccount, resetAccount, checkPassword, hashPassword, atomicWrite, contains, normalizeBaseUrl,
  markScanned, topology, isApplying: () => applying,
  setTopologyBusy: callback => { topologyBusy = callback; },
  onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
};
