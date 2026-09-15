const { AsyncLocalStorage } = require('node:async_hooks');
const { format } = require('node:util');
const { sanitize } = require('./debugLog');
const { resourceSeriesRootRelativePath } = require('./utils');

const storage = new AsyncLocalStorage();

function seriesIdentity(bundle) {
  const series = bundle?.series || bundle || {};
  const originalPaths = bundle?.originalPaths ? [...bundle.originalPaths] : [...new Set((bundle?.resources || []).map(resource => {
    const directory = resource.seriesRelativePath;
    return directory && directory !== '.' ? directory
      : resourceSeriesRootRelativePath(resource.relativePath) || resource.originalTitle || resource.sourcePath;
  }).filter(Boolean))];
  return { seriesId: series.seriesId || '', title: series.title || series.seriesId || '', originalPaths };
}

function withTask(task, operation) {
  return storage.run({ taskId: task.id, taskType: task.type }, operation);
}

function withSeries(bundle, operation) {
  const parent = storage.getStore() || {};
  const identity = seriesIdentity(bundle);
  return storage.run({ ...parent, ...(parent.seriesId === identity.seriesId ? {} : identity) }, operation);
}

function write(level, ...args) {
  try {
    const scope = storage.getStore() || {};
    const prefix = [scope.taskId ? `#${scope.taskId} ${scope.taskType}` : '',
      scope.seriesId ? `作品=${JSON.stringify(scope.title)} seriesId=${scope.seriesId} 原始路径=${JSON.stringify(scope.originalPaths)}` : '']
      .filter(Boolean).join(' ');
    const { credential } = require('./scrapeContext');
    const message = sanitize(`${prefix ? prefix + ' ' : ''}${format(...args)}`, [credential('aiApiKey'), credential('bangumiToken')]);
    // Keep each event on one line, even when filenames or upstream errors contain newlines.
    console[level](`[scrape] ${message}`.replace(/[\r\n\u2028\u2029]/g, ' '));
  } catch { /* A failed log sink must not change the scrape result. */ }
}

function task(task, message, details) {
  return withTask(task, () => write('log', message, ...(details ? [JSON.stringify(sanitize(details))] : [])));
}

module.exports = { seriesIdentity, withTask, withSeries, task,
  log: (...args) => write('log', ...args), warn: (...args) => write('warn', ...args), error: (...args) => write('error', ...args) };
