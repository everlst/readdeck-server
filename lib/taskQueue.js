const path = require('path');
const config = require('./config');
const settingsStore = require('./settingsStore');
const aiProvider = require('./aiProvider');
const scrapeLog = require('./scrapeLog');
const { withScrapeContext, captureContext } = require('./scrapeContext');
const { resourcesForScrape } = require('./automaticSources');
const { readIndex, readSeriesBundle, writeIndex } = require('./metadataStore');
const { scanLibrary } = require('./scanner');
const {
  fallbackBangumiToLocalMode,
  refreshLocalWorkGrouping,
  scrapeSeries,
  scrapeSeriesVolumes,
  updateArchiveIfNeeded,
} = require('./archiveSource');

const tasks = [];
let runningPrimaryTaskId = 0;
let runningPrimaryTaskType = '';
let runningScrapeSeriesTasks = 0;
let activeBatch = null;
const suspendedBatches = [];
let runLoopActive = false;
let nextTaskId = 1;
let taskPersistChain = Promise.resolve();
const seriesScrapeChains = new Map();
const taskListeners = new Set();
let taskVersion = 0;

function getTaskVersion() {
  return taskVersion;
}

function emitTasksChanged(reason = 'tasks_changed', taskState = snapshot()) {
  taskVersion += 1;
  const event = {
    version: taskVersion,
    reason,
    tasks: taskState,
    changedAt: new Date().toISOString(),
  };
  for (const listener of taskListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn(`[tasks] change listener failed: ${error.message}`);
    }
  }
  return event;
}

function onTasksChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

async function seriesScrapeSkipReason(seriesId, force = false) {
  const bundle = await readSeriesBundle(seriesId);
  if (!bundle) return '作品已不存在';
  if (force) return '';
  if (bundle.overrides?.bangumiScrapeDisabled) return '已禁用自动刮削';
  const protection = require('./scrapeProtection');
  if (!protection.hasResult(bundle) || (protection.subjectId(bundle.bangumi?.subjectId) &&
    protection.changedResources(bundle).length)) return '';
  return bundle.bangumi?.matchedBy === 'local_metadata_fallback'
    ? '已有本地回退结果，可强制重新刮削' : '已有刮削结果且无待补充资源';
}

async function shouldScrapeAddedVolumes(seriesId, resourceIds = []) {
  const targetIds = new Set((resourceIds || []).map(String).filter(Boolean));
  if (targetIds.size === 0) return false;
  const bundle = await readSeriesBundle(seriesId);
  if (!bundle || bundle.overrides?.bangumiScrapeDisabled) return false;
  const protection = require('./scrapeProtection');
  if (!protection.subjectId(bundle.bangumi?.subjectId)) return false;
  return protection.changedResources(bundle).some(resource =>
    resource.contentType === 'volume' && targetIds.has(String(resource.resourceId || ''))
  );
}

function canRunTaskNow(task) {
  if (!task || task.status !== 'queued' || settingsStore.isApplying()) return false;
  if (task.payload?.automatic) {
    const settings = settingsStore.snapshot();
    if (!settings.libraryConfirmed || settings.scanRequired || settingsStore.secrets().account?.mustChangePassword) return false;
  }

  if (task.type === 'scrapeSeries') {
    if (runningScrapeSeriesTasks + (activeBatch?.activeWorkers || 0) >= config.SCRAPE_SERIES_CONCURRENCY) return false;
    if (seriesScrapeChains.has(String(task.payload?.seriesId || ''))) return false;
    if (tasks.some(other => other !== task && other.type === 'scrapeSeries' && other.status === 'running' && other.payload?.seriesId === task.payload?.seriesId)) return false;
    // Scan snapshots stay exclusive; after commit, manual and batch scrapes share slots.
    return !runningPrimaryTaskType || (runningPrimaryTaskType === 'scanAndScrape' && activeBatch?.scanDone);
  }

  if (runningPrimaryTaskType) return false;
  if (runningScrapeSeriesTasks > 0) return false;
  return true;
}

function claimTaskSlot(task) {
  if (task.type === 'scrapeSeries') {
    runningScrapeSeriesTasks += 1;
    return;
  }
  runningPrimaryTaskId = task.id;
  runningPrimaryTaskType = task.type;
}

function releaseTaskSlot(task) {
  if (task.type === 'scrapeSeries') {
    runningScrapeSeriesTasks = Math.max(0, runningScrapeSeriesTasks - 1);
    return;
  }
  if (runningPrimaryTaskId === task.id) {
    runningPrimaryTaskId = 0;
    runningPrimaryTaskType = '';
  }
}

function runSeriesScrape(seriesId, options = {}) {
  const normalizedSeriesId = String(seriesId || '');
  if (!normalizedSeriesId) {
    return Promise.reject(new Error('seriesId is required'));
  }

  const previous = seriesScrapeChains.get(normalizedSeriesId) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const result = await (async () => {
        try {
          return await scrapeSeries(normalizedSeriesId, options);
        } catch (error) {
          if (options.force || require('./scrapeProtection').hasResult(await readSeriesBundle(normalizedSeriesId))) throw error;
          const fallback = await fallbackBangumiToLocalMode(normalizedSeriesId, {
            reason: options?.fallbackReason || 'scrape_failed',
            persistAsScrapeResult: true,
            automatic: options.automatic,
            respectAutoScrape: options.respectAutoScrape,
            sourceIds: options.sourceIds,
          }).catch(fallbackError => {
            throw new Error(`刮削失败：${error.message}；AI 简体中文化失败：${fallbackError.message}`);
          });
          if (!fallback) throw error;
          scrapeLog.warn(`刮削失败，本地元数据中文化回退成功: ${error.message}`);
          return {
            ...fallback,
            fallbackFromError: error.message,
          };
        }
      })();
      if (!options.automatic && !result.reused) await refreshLocalWorkGrouping(normalizedSeriesId).catch(error => {
        scrapeLog.warn(`逻辑作品分组失败: ${error.message}`);
      });
      return result;
    });
  const tracked = current.finally(() => {
    if (seriesScrapeChains.get(normalizedSeriesId) === tracked) {
      seriesScrapeChains.delete(normalizedSeriesId);
    }
  });
  seriesScrapeChains.set(normalizedSeriesId, tracked);
  return tracked;
}

function runSeriesVolumeScrape(seriesId, resourceIds, options = {}) {
  const normalizedSeriesId = String(seriesId || '');
  if (!normalizedSeriesId) return Promise.reject(new Error('seriesId is required'));

  const previous = seriesScrapeChains.get(normalizedSeriesId) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const result = await scrapeSeriesVolumes(normalizedSeriesId, resourceIds, options);
      return result;
    });
  const tracked = current.finally(() => {
    if (seriesScrapeChains.get(normalizedSeriesId) === tracked) {
      seriesScrapeChains.delete(normalizedSeriesId);
    }
  });
  seriesScrapeChains.set(normalizedSeriesId, tracked);
  return tracked;
}

function trimTasks(maxSize = 100) {
  if (tasks.length <= maxSize) return;

  for (let index = tasks.length - 1; index >= 0 && tasks.length > maxSize; index -= 1) {
    const task = tasks[index];
    if (task.status === 'running' || task.status === 'queued') continue;
    tasks.splice(index, 1);
  }

  while (tasks.length > maxSize) {
    const tail = tasks[tasks.length - 1];
    if (!tail || tail.status === 'running' || tail.status === 'queued') break;
    tasks.pop();
  }
}

function snapshot() {
  return tasks.map(task => ({
    id: task.id,
    type: task.type,
    payload: task.payload && typeof task.payload === 'object'
      ? {
          ...task.payload,
          ...(Array.isArray(task.payload.resourceIds)
            ? { resourceIds: [...task.payload.resourceIds] }
            : {}),
        }
      : task.payload,
    status: task.status,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    progress: task.progress ? { ...task.progress,
      ...(task.progress.failedSeries ? { failedSeries: task.progress.failedSeries.map(item => ({ ...item, originalPaths: [...item.originalPaths] })) } : {}) } : null,
  }));
}

async function persistTasks(reason = 'tasks_changed') {
  const taskState = snapshot();
  const run = taskPersistChain.then(async () => {
    await writeIndex('task-state.json', taskState);
    emitTasksChanged(reason, taskState);
  });
  taskPersistChain = run.then(() => undefined, () => undefined);
  return run;
}

async function scrapeTarget(task, target) {
  return scrapeLog.withTask(task, async () => {
  let identity = scrapeLog.seriesIdentity(target);
  try {
    identity = scrapeLog.seriesIdentity(await readSeriesBundle(target.seriesId) || target);
  } catch (error) {
    task.progress.failed += 1;
    task.progress.completed += 1;
    task.progress.failedSeries.push({ ...identity, error: error.message });
    scrapeLog.withSeries(identity, () => scrapeLog.warn(`本地元数据读取失败: ${error.message}`));
    return { seriesId: target.seriesId, error: error.message };
  }
  return scrapeLog.withSeries(identity, async () => {
    // Preserve the original paths captured before scraping changes display metadata.
    const startedAt = Date.now();
    let result, failure;
    try {
      scrapeLog.log(target.mode === 'volumes' ? `新增卷刮削开始: ${target.resourceIds.length} 卷` : '作品刮削开始');
      result = target.mode === 'volumes'
        ? await runSeriesVolumeScrape(target.seriesId, target.resourceIds, task.payload || {})
        : await runSeriesScrape(target.seriesId, task.payload || {});
      const fallback = result?.fallbackFromError ||
        (result?.bangumi?.matchedBy === 'local_metadata_fallback' && (result.bangumi.fallbackReason || '未匹配 BGM，已回退本地元数据'));
      if (result?.skipped || (result?.reused && !result.volumesUpdated && !result.fallbackFromError)) {
        task.progress.skipped += 1;
        scrapeLog.log(`刮削跳过: ${result.reason || '复用已有结果'}`);
      } else if (fallback || result?.error || result?.success === false) {
        failure = fallback || result.error || result.reason || '刮削未成功';
      } else {
        task.progress.success += 1;
        scrapeLog.log(`刮削成功，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
      }
    } catch (error) {
      failure = error.message;
      result = { seriesId: target.seriesId, error: failure };
    }
    if (failure) {
      task.progress.failed += 1;
      task.progress.failedSeries.push({ ...identity, error: failure });
      scrapeLog.warn(`刮削失败: ${failure}`);
    }
    task.progress.completed += 1;
    return result;
  });
  });
}

function logScrapeSummary(task) {
  const progress = task.progress;
  if (!progress || !['scrapeSeries', 'scanAndScrape'].includes(task.type)) return;
  scrapeLog.task(task, `刮削总结: 成功 ${progress.success} 本，失败 ${progress.failed} 本，跳过 ${progress.skipped || 0} 本；处理 ${progress.completed}/${progress.total} 本`);
  for (const failure of progress.failedSeries || []) {
    scrapeLog.withSeries(failure, () => scrapeLog.warn(`失败清单: ${failure.error}`));
  }
}

async function execute(task) {
  if (task.type === 'scanLibrary') {
    scrapeLog.log('书库扫描开始');
    const result = await scanLibrary({
      fast: task.payload?.fastScan === true,
      concurrency: task.payload?.concurrency,
      confirmSettings: task.payload?.confirmSettings === true,
      changedPaths: task.payload?.changedPaths,
    });
    await reconcileSuspendedBatches();
    return result;
  }
  if (task.type === 'scrapeSeries') {
    task.progress = { total: 1, completed: 0, success: 0, failed: 0, skipped: 0, failedSeries: [] };
    const result = await aiProvider.withPriority(1, () => scrapeTarget(task, { seriesId: task.payload.seriesId }));
    if (result?.error) throw new Error(result.error);
    return result;
  }
  if (task.type === 'updateArchive') {
    scrapeLog.log('元数据档案更新开始');
    return updateArchiveIfNeeded(task.payload || {});
  }
  if (task.type === 'scanAndScrape') {
    scrapeLog.log('扫描并刮削开始');
    const force = task.payload?.force === true;
    const fastScan = task.payload?.fastScan !== false;
    const specificSeriesId = String(task.payload?.seriesId || '');
    const queuedSeriesIds = new Set();
    const scrapeQueue = [];
    let activeWorkers = 0;
    let scanFinished = false;
    let targetsReady = false;
    let idleResolved = false;

    const results = [];
    let resolveIdle;
    const idlePromise = new Promise(resolve => {
      resolveIdle = resolve;
    });

    const isSeriesAllowed = seriesId => !specificSeriesId || seriesId === specificSeriesId;

    task.progress = {
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      failedSeries: [],
      discovered: 0,
      queued: 0,
      running: 0,
      volumeOnlyTotal: 0,
      scanDone: false,
      fastScan,
      lastSeriesId: '',
      lastSeriesTitle: '',
      updatedAt: new Date().toISOString(),
    };
    await persistTasks();

    function maybeResolveIdle() {
      if (idleResolved) return;
      if (!scanFinished) return;
      if (!targetsReady) return;
      if (activeWorkers > 0) return;
      if (scrapeQueue.length > 0) return;
      idleResolved = true;
      resolveIdle();
    }

    function enqueueScrapeTarget(seriesId, title, targetOptions = {}) {
      if (!isSeriesAllowed(seriesId)) return false;
      if (queuedSeriesIds.has(seriesId)) return false;
      queuedSeriesIds.add(seriesId);
      if (tasks.some(other => other.type === 'scrapeSeries' && other.id > task.id && other.payload?.seriesId === seriesId)) return false;
      const target = {
        seriesId,
        title: title || seriesId,
        mode: targetOptions.mode === 'volumes' ? 'volumes' : 'series',
        resourceIds: targetOptions.resourceIds || [],
      };
      scrapeQueue.push(target);
      task.progress.total += 1;
      if (target.mode === 'volumes') task.progress.volumeOnlyTotal += 1;
      task.progress.queued = scrapeQueue.length;
      task.progress.updatedAt = new Date().toISOString();
      persistTasks().catch(() => {});
      setImmediate(runNext);
      return true;
    }

    async function runScrapeTarget(target) {
      try {
        results.push(await scrapeTarget(task, target));
      } finally {
        task.progress.lastSeriesId = target.seriesId;
        task.progress.lastSeriesTitle = target.title;
        task.progress.queued = scrapeQueue.length;
        task.progress.running = activeWorkers;
        task.progress.updatedAt = new Date().toISOString();
        await persistTasks();
      }
    }

    function runScrapeWorkers() {
      while (activeWorkers + runningScrapeSeriesTasks < config.SCRAPE_SERIES_CONCURRENCY && scrapeQueue.length > 0) {
        if (targetsReady && hasPendingLocalScan()) {
          if (activeWorkers === 0 && runningScrapeSeriesTasks === 0) setImmediate(runNext);
          break;
        }
        if (tasks.some(other => other.type === 'scrapeSeries' && canRunTaskNow(other))) { setImmediate(runNext); break; }
        const target = scrapeQueue.shift();
        activeWorkers += 1;
        task.progress.running = activeWorkers;
        task.progress.queued = scrapeQueue.length;
        task.progress.updatedAt = new Date().toISOString();
        persistTasks().catch(() => {});

        runScrapeTarget(target)
          .catch(error => {
            scrapeLog.withSeries(target, () => scrapeLog.warn(`worker 异常: ${error.message}`));
          })
          .finally(() => {
            activeWorkers -= 1;
            task.progress.running = activeWorkers;
            task.progress.queued = scrapeQueue.length;
            task.progress.updatedAt = new Date().toISOString();
            persistTasks().catch(() => {});
            setImmediate(runNext);
            maybeResolveIdle();
          });
      }
    }

    const batchController = {
      task,
      get activeWorkers() { return activeWorkers; },
      get scanDone() { return scanFinished; },
      get canYield() { return targetsReady && activeWorkers === 0; },
      runWorkers: runScrapeWorkers,
      prioritizeSeries(seriesId) {
        const index = scrapeQueue.findIndex(target => target.seriesId === seriesId);
        if (index < 0) return;
        const [target] = scrapeQueue.splice(index, 1);
        task.progress.total -= 1;
        if (target.mode === 'volumes') task.progress.volumeOnlyTotal -= 1;
        task.progress.queued = scrapeQueue.length;
        task.progress.updatedAt = new Date().toISOString();
        maybeResolveIdle();
      },
      removeMissingSeries(visibleIds) {
        for (const target of [...scrapeQueue]) if (!visibleIds.has(target.seriesId)) this.prioritizeSeries(target.seriesId);
      },
    };
    activeBatch = batchController;
    try {
      const scanResult = await scanLibrary({
        fast: fastScan,
        concurrency: task.payload?.scanConcurrency,
        confirmSettings: task.payload?.confirmSettings === true,
        changedPaths: task.payload?.changedPaths,
        onSeriesDiscovered(discovered) {
          task.progress.discovered += 1;
          task.progress.updatedAt = new Date().toISOString();
          persistTasks().catch(() => {});
        },
      });
      await reconcileSuspendedBatches();
      scrapeLog.log(`书库扫描成功: ${(scanResult.seriesList || []).length} 本作品，${(scanResult.resourceList || []).length} 个资源`);

      const allowedResourceIds = new Set((await resourcesForScrape(scanResult.resourceList, task.payload)).map(r => r.resourceId));
      const resourceAllowed = resource => allowedResourceIds.has(resource.resourceId);
      const resourceStats = new Map();
      for (const resource of scanResult.resourceList || []) {
        if (!resource?.seriesId) continue;
        const current = resourceStats.get(resource.seriesId) || { resourceCount: 0, pageCount: 0 };
        current.resourceCount += 1;
        current.pageCount += Number(resource.pageCount || 0);
        resourceStats.set(resource.seriesId, current);
      }

      const finalCandidates = (scanResult.seriesList || [])
        .filter(series => isSeriesAllowed(series.seriesId))
        .sort((a, b) => {
          const aStats = resourceStats.get(a.seriesId) || { resourceCount: 0, pageCount: 0 };
          const bStats = resourceStats.get(b.seriesId) || { resourceCount: 0, pageCount: 0 };
          return bStats.resourceCount - aStats.resourceCount ||
            bStats.pageCount - aStats.pageCount ||
            String(a.title || '').localeCompare(String(b.title || ''));
        });
      const addedVolumesBySeries = new Map();
      for (const resource of scanResult.addedVolumeResources || []) {
        if (!resource?.seriesId || !resource?.resourceId) continue;
        if (!addedVolumesBySeries.has(resource.seriesId)) addedVolumesBySeries.set(resource.seriesId, []);
        addedVolumesBySeries.get(resource.seriesId).push(resource.resourceId);
      }

      scanFinished = true;
      task.progress.scanDone = true;
      task.progress.updatedAt = new Date().toISOString();
      await persistTasks();

      for (const series of finalCandidates) {
        if (queuedSeriesIds.has(series.seriesId)) continue;
        const seriesResources = (scanResult.resourceList || []).filter(r => r.seriesId === series.seriesId);
        const skip = reason => {
          task.progress.skipped += 1;
          scrapeLog.withSeries({ series, resources: seriesResources }, () => scrapeLog.log(`刮削跳过: ${reason}`));
        };
        if (!seriesResources.some(resourceAllowed)) {
          skip('来源未启用自动刮削或不在本次范围内');
          continue;
        }
        const skipReason = await seriesScrapeSkipReason(series.seriesId, force);
        if (!skipReason) {
          enqueueScrapeTarget(series.seriesId, series.title);
          continue;
        }
        const addedVolumeIds = (addedVolumesBySeries.get(series.seriesId) || []).filter(id => allowedResourceIds.has(id));
        if (await shouldScrapeAddedVolumes(series.seriesId, addedVolumeIds)) {
          enqueueScrapeTarget(series.seriesId, `${series.title}（新增 ${addedVolumeIds.length} 卷）`, {
            mode: 'volumes',
            resourceIds: addedVolumeIds,
          });
        } else skip(skipReason);
      }

      scrapeLog.log(`刮削目标: ${task.progress.total}/${(scanResult.seriesList || []).length} 本作品`);
      targetsReady = true;
      runScrapeWorkers();
      maybeResolveIdle();
      await idlePromise;

      return results;
    } finally {
      if (activeBatch === batchController) activeBatch = null;
      const suspendedIndex = suspendedBatches.indexOf(batchController);
      if (suspendedIndex >= 0) suspendedBatches.splice(suspendedIndex, 1);
    }
  }
  throw new Error(`Unknown task type: ${task.type}`);
}

async function runTask(task) {
  try {
    await persistTasks();
    task.result = await withScrapeContext(captureContext(), () => execute(task));
    task.status = 'success';
    task.finishedAt = new Date().toISOString();
    scrapeLog.log(task.progress?.failed ? `任务执行完成，含 ${task.progress.failed} 本刮削失败` : '任务执行成功');
  } catch (error) {
    task.status = 'failed';
    task.error = error.message;
    task.finishedAt = new Date().toISOString();
    scrapeLog.error(`任务执行失败: ${error.message}`);
  } finally {
    logScrapeSummary(task);
    const rerunPayload = task.rerunPayload;
    delete task.rerunPayload;
    releaseTaskSlot(task);
    await persistTasks();
    if (rerunPayload) {
      await enqueueTask(task.type, {
        ...rerunPayload,
        reason: 'watcher_trailing',
      });
    }
    setImmediate(runNext);
  }
}

async function runNext() {
  if (runLoopActive) return;
  runLoopActive = true;

  try {
    // Finish current work before a watcher scan, then resume the remaining scrape queue.
    // Keeping scans exclusive prevents long-running scrapes from writing stale resources.
    if (activeBatch?.canYield && runningScrapeSeriesTasks === 0 && hasPendingLocalScan()) {
      suspendedBatches.push(activeBatch);
      activeBatch = null;
      runningPrimaryTaskId = 0;
      runningPrimaryTaskType = '';
    }
    while (true) {
      const task = tasks.filter(canRunTaskNow).sort((a, b) =>
        taskPriority(b) - taskPriority(a) || a.id - b.id)[0];
      if (!task) break;

      claimTaskSlot(task);
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      scrapeLog.task(task, '任务运行中');

      scrapeLog.withTask(task, () => runTask(task)).catch(error => {
        scrapeLog.withTask(task, () => scrapeLog.error(`任务调度失败: ${error.message}`));
      });
    }
    if (!runningPrimaryTaskType && !runningScrapeSeriesTasks && suspendedBatches.length) {
      activeBatch = suspendedBatches.pop();
      runningPrimaryTaskId = activeBatch.task.id;
      runningPrimaryTaskType = activeBatch.task.type;
    }
    activeBatch?.runWorkers();
  } finally {
    runLoopActive = false;
  }
}

function taskPriority(task) {
  return task.type === 'scrapeSeries' ? 2 : Array.isArray(task.payload?.changedPaths) ? 1 : 0;
}

function hasPendingLocalScan() {
  if (settingsStore.isApplying()) return false;
  const settings = settingsStore.snapshot();
  const automaticAllowed = settings.libraryConfirmed && !settings.scanRequired && !settingsStore.secrets().account?.mustChangePassword;
  return tasks.some(task => task.status === 'queued' && ['scanLibrary', 'scanAndScrape'].includes(task.type) &&
    Array.isArray(task.payload?.changedPaths) && (!task.payload.automatic || automaticAllowed));
}

async function reconcileSuspendedBatches() {
  if (!suspendedBatches.length) return;
  const visibleIds = new Set((await readIndex('series-index.json', [])).map(series => series.seriesId));
  for (const batch of suspendedBatches) batch.removeMissingSeries(visibleIds);
}

function mergeScanScope(previous, next) {
  if (!previous) return { sourceIds: next.sourceIds, changedPaths: next.changedPaths };
  return {
    sourceIds: !previous.sourceIds?.length || !next.sourceIds?.length
      ? [] : [...new Set([...previous.sourceIds, ...next.sourceIds])],
    // A pending full scan subsumes local changes; two local scans must retain every path.
    changedPaths: Array.isArray(previous.changedPaths) && Array.isArray(next.changedPaths)
      ? [...new Set([...previous.changedPaths, ...next.changedPaths])] : undefined,
  };
}

async function enqueueTask(type, payload = {}) {
  // Keep manual scheduling/confirmation while enforcing source scope for every library batch.
  if (type === 'scanAndScrape') payload = { ...payload, respectAutoScrape: true };
  const canReuseTask = (type === 'scanAndScrape' || type === 'scanLibrary') &&
    !payload.force &&
    !payload.seriesId;
  if (canReuseTask) {
    const existing = tasks.find(item =>
      item.type === type &&
      (item.status === 'queued' || item.status === 'running') &&
      !item.payload?.force &&
      !!item.payload?.automatic === !!payload.automatic &&
      !!item.payload?.confirmSettings === !!payload.confirmSettings &&
      !(item.status === 'running' && Array.isArray(item.payload?.changedPaths) && !Array.isArray(payload.changedPaths)) &&
      !(item.status === 'running' && item.progress?.scanDone && Array.isArray(payload.changedPaths)) &&
      !item.payload?.seriesId
    );
    if (existing) {
      if (existing.status === 'running' && (Array.isArray(payload.changedPaths) || ['watcher', 'watcher_trailing'].includes(payload.reason))) {
        existing.rerunPayload = {
          ...(existing.rerunPayload || {}),
          ...payload,
          ...mergeScanScope(existing.rerunPayload, payload),
        };
      } else if (existing.status === 'queued') {
        Object.assign(existing.payload, mergeScanScope(existing.payload, payload));
      }
      await persistTasks();
      scrapeLog.task(existing, '复用任务', payload);
      return existing;
    }
  }

  if (type === 'scrapeSeries') {
    const normalizedSeriesId = String(payload.seriesId || '');
    const normalizedSubjectId = Number(payload.subjectId || 0);
    const existing = tasks.find(item =>
      item.type === 'scrapeSeries' &&
      (item.status === 'queued' || item.status === 'running') &&
      (item.payload?.force === true) === (payload.force === true) &&
      String(item.payload?.seriesId || '') === normalizedSeriesId &&
      Number(item.payload?.subjectId || 0) === normalizedSubjectId
    );
    if (existing) {
      scrapeLog.task(existing, '复用任务', payload);
      return existing;
    }
  }

  const task = {
    id: nextTaskId++,
    type,
    payload,
    status: 'queued',
    error: '',
    createdAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
  };
  tasks.unshift(task);
  if (type === 'scrapeSeries') {
    for (const batch of [...suspendedBatches, ...(activeBatch ? [activeBatch] : [])]) batch.prioritizeSeries(String(payload.seriesId || ''));
  }
  trimTasks(100);
  await persistTasks();
  scrapeLog.task(task, '任务入队', payload);
  setImmediate(runNext);
  return task;
}

async function restoreTaskIds() {
  const oldTasks = await readIndex('task-state.json', []);
  const maxId = oldTasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0);
  nextTaskId = maxId + 1;
  for (const task of oldTasks.slice(0, 30)) {
    tasks.push({
      ...task,
      status: ['running', 'queued'].includes(task.status) ? 'failed' : task.status,
      error: ['running', 'queued'].includes(task.status) ? '服务重启时任务中断，请手动重新运行' : task.error,
    });
  }
}

async function waitForTask(task, options = {}) {
  if (!task) throw new Error('Task not found');
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10 * 60 * 1000));
  const startedAt = Date.now();
  while (task.status === 'queued' || task.status === 'running') {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Task #${task.id} timed out`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (task.status === 'failed') throw new Error(task.error || `Task #${task.id} failed`);
  return task.result;
}

settingsStore.setTopologyBusy(() => !!runningPrimaryTaskType || runningScrapeSeriesTasks > 0 || suspendedBatches.length > 0);
settingsStore.onChanged(() => setImmediate(runNext));

module.exports = {
  enqueueTask,
  getTaskVersion,
  onTasksChanged,
  restoreTaskIds,
  snapshot,
  waitForTask,
};
