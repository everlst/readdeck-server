const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const WEB_SCRAPE_POLICY_VERSION = 4;
const TRADITIONAL_SCRAPE_POLICY_VERSION = 1;
const storage = new AsyncLocalStorage();
// Credentials never become enumerable fields on a task or a serializable context.
const snapshots = new WeakMap();

function scrapePolicy(metadata = require('./settingsStore').snapshot().metadata) {
  const mode = metadata.aiWebSearchEnabled === true ? 'web' : 'traditional';
  return { mode, policyVersion: mode === 'web' ? WEB_SCRAPE_POLICY_VERSION : TRADITIONAL_SCRAPE_POLICY_VERSION };
}

// Call at execution time, after a queued task has acquired its slot.
function captureContext() {
  const store = require('./settingsStore');
  const metadata = Object.freeze(store.snapshot().metadata);
  const secrets = store.secrets();
  const context = Object.freeze({ ...scrapePolicy(metadata), startedAt: new Date().toISOString() });
  snapshots.set(context, { metadata, aiApiKey: secrets.aiApiKey || '', bangumiToken: secrets.bangumiToken || '' });
  return context;
}

function currentContext() { return storage.getStore() || null; }
function withScrapeContext(context, operation) {
  if (typeof context === 'function') {
    operation = context;
    context = currentContext() || captureContext();
  }
  if (!snapshots.has(context) || typeof operation !== 'function') throw new TypeError('刮削上下文必须在任务执行时捕获，不能从持久化任务恢复');
  return storage.run(context, operation);
}
function metadataSettings() {
  return snapshots.get(currentContext())?.metadata || require('./settingsStore').snapshot().metadata;
}
function credential(name) {
  if (!['aiApiKey', 'bangumiToken'].includes(name)) throw new TypeError('未知刮削凭据');
  const captured = snapshots.get(currentContext());
  return captured ? captured[name] : require('./settingsStore').secrets()[name] || '';
}

// Object key order is immaterial; raw names, resource IDs and array order are not.
// Hash only recognition input, never a settings object or credentials.
function inputFingerprint(input) {
  const canonicalize = value => {
    if (Array.isArray(value)) return value.map(item => canonicalize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, canonicalize(value[key])]));
    return value;
  };
  const serialized = JSON.stringify(canonicalize(input));
  if (serialized === undefined) throw new TypeError('刮削输入不能为空');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

module.exports = { WEB_SCRAPE_POLICY_VERSION, TRADITIONAL_SCRAPE_POLICY_VERSION, captureContext,
  withScrapeContext, runWithScrapeContext: withScrapeContext, currentContext, scrapePolicy, metadataSettings, credential, inputFingerprint };
