const path = require('path');
const store = require('./settingsStore');
const { isIgnoredLibraryPath } = require('./libraryIgnore');

function createLibraryWatcher({ enqueueTask, invalidate, notify = () => {} }) {
  let watcher;
  let timer;
  let chain = Promise.resolve();
  let generation = 0;
  let closed = false;
  let watchedPaths = [];
  let watchSignature = '';
  const pending = new Map();
  let lastError = '';
  function ready() {
    const settings = store.snapshot();
    return settings.libraryConfirmed && !settings.scanRequired && !store.secrets().account?.mustChangePassword;
  }
  function event(eventPath) {
    if (!ready()) return;
    const source = store.snapshot().sources.find(s => s.enabled && s.watch && store.contains(s.path, eventPath));
    if (!source) return;
    if (isIgnoredLibraryPath(path.relative(source.path, eventPath))) return;
    pending.set(path.resolve(eventPath), source.id);
    // Flush at a bounded interval, even while a large copy keeps producing events.
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const sources = store.snapshot().sources.filter(s => s.enabled && s.watch);
      const changedPaths = [...pending].filter(([target, id]) =>
        sources.some(s => s.id === id && store.contains(s.path, target))).map(([target]) => target);
      const sourceIds = sources.filter(s => changedPaths.some(target => store.contains(s.path, target))).map(s => s.id);
      pending.clear();
      if (!ready() || !sourceIds.length) return;
      invalidate();
      const scrape = store.snapshot().sources.some(s => sourceIds.includes(s.id) && s.autoScrape);
      await enqueueTask(scrape ? 'scanAndScrape' : 'scanLibrary', {
        reason: 'watcher', automatic: true, sourceIds, changedPaths, fastScan: true, force: false,
      }).catch(error => { lastError = error.message; notify(); });
    }, 2000);
    timer.unref();
  }
  async function rebuild() {
    const requested = ++generation;
    chain = chain.catch(() => {}).then(async () => {
      if (!ready() || closed) { clearTimeout(timer); timer = null; pending.clear(); }
      if (requested !== generation) return;
      const settings = store.snapshot();
      const candidates = !closed && ready() ? settings.sources.filter(s => s.enabled && s.watch) : [];
      const states = await Promise.all(candidates.map(store.sourceStatus));
      const available = candidates.filter((s, i) => states[i].available).map(s => s.path);
      const signature = JSON.stringify([available, settings.scanning.usePolling, settings.scanning.intervalMs]);
      // Concurrency and metadata settings do not require re-enumerating watched directories.
      if (watcher && available.length && signature === watchSignature && !lastError) return;
      if (watcher) await watcher.close();
      watcher = null;
      watchedPaths = [];
      if (closed || requested !== generation || !ready()) return;
      watchedPaths = available;
      watchSignature = signature;
      if (!watchedPaths.length) return;
      const { watch } = await import('chokidar');
      watcher = watch(watchedPaths, {
        ignoreInitial: true, followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
        ignorePermissionErrors: true, usePolling: settings.scanning.usePolling,
        interval: settings.scanning.intervalMs,
        ignored: target => available.some(root => store.contains(root, target) &&
          isIgnoredLibraryPath(path.relative(root, target))),
      });
      const relevant = p => /\.(zip|cbz|rar|pdf|epub|avif|bmp|jpe?g|png|gif|webp)$/i.test(p) || path.basename(p) === '元数据.json';
      watcher.on('addDir', event).on('unlinkDir', event);
      for (const type of ['add', 'change', 'unlink']) watcher.on(type, p => { if (relevant(p)) event(p); });
      watcher.on('error', error => { lastError = error.code || '监听器不可用'; notify(); });
      lastError = '';
    });
    return chain.catch(error => {
      lastError = error.code || '监听器重建失败';
      notify();
      throw error;
    });
  }
  const recovery = setInterval(() => {
    if (closed) return;
    const sources = store.snapshot().sources.filter(s => s.enabled && s.watch);
    Promise.all(sources.map(store.sourceStatus)).then(async states => {
      const available = sources.filter((s, i) => states[i].available).map(s => s.path);
      if (ready() && JSON.stringify(available) !== JSON.stringify(watchedPaths)) {
        const restored = available.filter(target => !watchedPaths.includes(target));
        await rebuild();
        // ignoreInitial skips changes made while disconnected; reconcile only restored sources.
        for (const target of restored) event(target);
      }
    }).catch(() => {});
  }, 30000);
  recovery.unref();
  return {
    rebuild,
    status: () => ({ paths: [...watchedPaths], error: lastError, paused: !ready() }),
    close: async () => { closed = true; clearInterval(recovery); clearTimeout(timer); ++generation; await chain.catch(() => {}); await watcher?.close(); },
  };
}
module.exports = { createLibraryWatcher };
