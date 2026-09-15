const path = require('path');
const config = require('./config');
const { ensureDir, readJson, writeJson } = require('./utils');

const WORKS_DIR = path.join(config.METADATA_DIR, 'works');
const WORK_REGISTRY_PATH = path.join(WORKS_DIR, '_registry.json');
const workOperationChains = new Map();

function normalizeWorkCategory(value) {
  return String(value || 'comic').trim() || 'comic';
}

function workIdFor({ category = 'comic', subjectId = 0, metadataKey = '', seriesId = '' } = {}) {
  const normalizedCategory = normalizeWorkCategory(category);
  const normalizedSubjectId = Number(subjectId || 0);
  if (Number.isSafeInteger(normalizedSubjectId) && normalizedSubjectId > 0) return `subject:${normalizedCategory}:${normalizedSubjectId}`;
  if (String(metadataKey || '').trim()) return `metadata:${normalizedCategory}:${String(metadataKey).trim()}`;
  return `series:${normalizedCategory}:${String(seriesId || 'unknown')}`;
}

function workIdForBundle(bundle) {
  return workIdFor({
    category: bundle?.series?.category || 'comic',
    subjectId: bundle?.bangumi?.subjectId || bundle?.series?.bangumiSubjectId || 0,
    metadataKey: bundle?.bangumi?.metadataKey || bundle?.series?.metadataKey || '',
    seriesId: bundle?.series?.seriesId || '',
  });
}

function workStorageDir(workId) {
  return path.join(WORKS_DIR, encodeURIComponent(String(workId || 'unknown')));
}

function defaultWorkState(workId) {
  return {
    schemaVersion: 1,
    workId: String(workId || ''),
    seriesIds: [],
    modelGroups: {},
    manualSplits: {},
    overrides: {},
    updatedAt: '',
  };
}

function withWorkOperation(workId, operation) {
  const key = String(workId || '');
  const previous = workOperationChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tracked = current.finally(() => {
    if (workOperationChains.get(key) === tracked) workOperationChains.delete(key);
  });
  workOperationChains.set(key, tracked);
  return tracked;
}

async function readWorkState(workId) {
  const key = String(workId || '');
  if (!key) return defaultWorkState('');
  const current = await readJson(path.join(workStorageDir(key), 'work.json'), null);
  return {
    ...defaultWorkState(key),
    ...(current || {}),
    workId: key,
    seriesIds: Array.isArray(current?.seriesIds) ? current.seriesIds : [],
    modelGroups: current?.modelGroups || {},
    manualSplits: current?.manualSplits || {},
    overrides: current?.overrides || {},
  };
}

async function updateWorkState(workId, updater) {
  const key = String(workId || '');
  if (!key) throw new Error('workId is required');
  return withWorkOperation(key, async () => {
    const current = await readWorkState(key);
    const patch = typeof updater === 'function' ? await updater(current) : updater;
    const next = {
      ...current,
      ...(patch || {}),
      workId: key,
      seriesIds: Array.isArray(patch?.seriesIds) ? patch.seriesIds : (current.seriesIds || []),
      modelGroups: patch?.modelGroups || current.modelGroups || {},
      manualSplits: patch?.manualSplits || current.manualSplits || {},
      overrides: patch?.overrides || current.overrides || {},
      updatedAt: new Date().toISOString(),
    };
    const dir = workStorageDir(key);
    await ensureDir(dir);
    await writeJson(path.join(dir, 'work.json'), next);
    return next;
  });
}

function defaultWorkRegistry() {
  return {
    schemaVersion: 1,
    seriesWorkIds: {},
    updatedAt: '',
  };
}

async function readWorkRegistry() {
  const current = await readJson(WORK_REGISTRY_PATH, null);
  return {
    ...defaultWorkRegistry(),
    ...(current || {}),
    seriesWorkIds: current?.seriesWorkIds || {},
  };
}

async function updateWorkRegistry(updater) {
  return withWorkOperation('__registry__', async () => {
    const current = await readWorkRegistry();
    const patch = typeof updater === 'function' ? await updater(current) : updater;
    const next = {
      ...current,
      ...(patch || {}),
      seriesWorkIds: patch?.seriesWorkIds || current.seriesWorkIds || {},
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(WORKS_DIR);
    await writeJson(WORK_REGISTRY_PATH, next);
    return next;
  });
}

async function resolveWorkIdForBundle(bundle) {
  const subjectId = Number(bundle?.bangumi?.subjectId || bundle?.series?.bangumiSubjectId || 0);
  if (subjectId > 0 || bundle?.bangumi?.metadataKey || bundle?.series?.metadataKey) return workIdForBundle(bundle);
  const seriesId = String(bundle?.series?.seriesId || '');
  if (!seriesId) return workIdForBundle(bundle);
  const registry = await readWorkRegistry();
  return String(registry.seriesWorkIds?.[seriesId] || workIdForBundle(bundle));
}

async function assignSeriesToWork(workId, seriesIds = [], metadata = {}) {
  const key = String(workId || '');
  const normalizedSeriesIds = Array.from(new Set((seriesIds || []).map(String).filter(Boolean)));
  if (!key || normalizedSeriesIds.length === 0) return null;

  await updateWorkRegistry(current => {
    const seriesWorkIds = { ...(current.seriesWorkIds || {}) };
    for (const seriesId of normalizedSeriesIds) seriesWorkIds[seriesId] = key;
    return { ...current, seriesWorkIds };
  });

  return updateWorkState(key, current => ({
    ...current,
    seriesIds: Array.from(new Set([...(current.seriesIds || []), ...normalizedSeriesIds])),
    modelWork: metadata && Object.keys(metadata).length > 0
      ? {
          ...(current.modelWork || {}),
          ...metadata,
          updatedAt: new Date().toISOString(),
        }
      : current.modelWork,
  }));
}

async function seriesIdsForWork(workId, fallbackSeriesIds = []) {
  const key = String(workId || '');
  const registry = await readWorkRegistry();
  const registered = Object.entries(registry.seriesWorkIds || {})
    .filter(([, value]) => String(value || '') === key)
    .map(([seriesId]) => seriesId);
  return Array.from(new Set([...(fallbackSeriesIds || []), ...registered].map(String).filter(Boolean)));
}

async function replaceModelGroups(workId, modelGroups = {}) {
  return updateWorkState(workId, current => ({
    ...current,
    modelGroups: modelGroups || {},
  }));
}

async function setManualSplit(workId, resourceId, kind = 'book') {
  const normalizedResourceId = String(resourceId || '');
  if (!normalizedResourceId) throw new Error('resourceId is required');
  return updateWorkState(workId, current => ({
    ...current,
    manualSplits: {
      ...(current.manualSplits || {}),
      [normalizedResourceId]: {
        groupKey: `split:${normalizedResourceId}`,
        kind: kind === 'chapter' ? 'chapter' : 'book',
        createdAt: new Date().toISOString(),
      },
    },
  }));
}

async function clearManualSplit(workId, resourceId) {
  const normalizedResourceId = String(resourceId || '');
  return updateWorkState(workId, current => {
    const manualSplits = { ...(current.manualSplits || {}) };
    delete manualSplits[normalizedResourceId];
    return { ...current, manualSplits };
  });
}

async function updateWorkOverrides(workId, patch = {}) {
  return updateWorkState(workId, current => {
    const overrides = {
      ...(current.overrides || {}),
      ...(patch || {}),
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete overrides[key];
    }
    return { ...current, overrides };
  });
}

function effectiveGroupForResource(workState, resourceId, fallbackKey = '') {
  const key = String(resourceId || '');
  const split = workState?.manualSplits?.[key];
  if (split?.groupKey) return split.groupKey;
  const model = workState?.modelGroups?.[key];
  return model?.groupKey || String(fallbackKey || `resource:${key}`);
}

module.exports = {
  WORKS_DIR,
  WORK_REGISTRY_PATH,
  assignSeriesToWork,
  clearManualSplit,
  effectiveGroupForResource,
  readWorkRegistry,
  readWorkState,
  replaceModelGroups,
  resolveWorkIdForBundle,
  seriesIdsForWork,
  setManualSplit,
  updateWorkRegistry,
  updateWorkOverrides,
  updateWorkState,
  withWorkOperation,
  workIdFor,
  workIdForBundle,
  workStorageDir,
};
