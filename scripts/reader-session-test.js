const assert = require('node:assert/strict');
const { app } = require('../public/app');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('reader did not reach the expected response stage')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const appDescriptors = Object.getOwnPropertyDescriptors(app);
  const globalDescriptors = Object.fromEntries(['document', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const response = data => ({ ok: true, status: 200, json: async () => data });
  const chapter = resourceId => ({ resourceId, chapterUuid: 'shared-volume', chapterTitle: resourceId,
    resourceType: 'cbz', contentType: 'volume', groupName: '单行本' });
  const a = chapter('source-a'), b = chapter('source-b');
  const writes = [];
  try {
    app.state = { ...app.state, currentComic: { comic: { id: 'work', name: '测试作品' } },
      currentChapter: a, currentGroup: 'volumes', progressCache: {}, novelMode: false };
    app.authFetch = async (url, options) => {
      writes.push({ url, body: JSON.parse(options.body) });
      return response({});
    };
    app.saveProgress(80);
    app.state.currentChapter = b;
    await app.flushReaderProgress();
    app.saveProgress(7);
    await app.flushReaderProgress();
    assert.deepEqual(writes.map(write => [write.body.resourceId, write.body.page]), [['source-a', 80], ['source-b', 7]]);
    assert.equal(app.state.progressCache.work.resources['source-a'].page, 80);
    assert.equal(app.state.progressCache.work.resources['source-b'].page, 7);
    assert.equal(app._pendingProgressSave, null);

    app.state.currentChapter = { ...a, resourceType: 'epub' };
    app.state.currentChapterIndex = 2;
    app.state.novelMode = true;
    app.state.novelScrollPercent = 25;
    app._epubLocation = { start: { cfi: 'epubcfi(/6/4)' } };
    app.saveNovelProgress();
    app.state.currentChapter = { ...b, resourceType: 'epub' };
    app.state.currentChapterIndex = 5;
    app.state.novelScrollPercent = 60;
    app._epubLocation = { start: { cfi: 'epubcfi(/6/10)' } };
    await app.flushReaderProgress();
    assert.equal(writes.at(-1).body.resourceId, 'source-a');
    assert.equal(writes.at(-1).body.cfi, 'epubcfi(/6/4)');
    assert.equal(writes.at(-1).body.page, 2);
    assert.equal(writes.at(-1).body.scrollPercent, 25);
    app.saveNovelProgress();
    await app.flushReaderProgress();
    assert.equal(app.state.progressCache.work.resources['source-a'].cfi, 'epubcfi(/6/4)');
    assert.equal(app.state.progressCache.work.resources['source-b'].cfi, 'epubcfi(/6/10)');

    const storage = new Map();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
    globalThis.fetch = async () => { throw new Error('offline'); };
    app.authFetch = appDescriptors.authFetch.value;
    app.state.userId = 'reader';
    app.state.token = null;
    app.deviceId = 'browser';
    for (const [item, page] of [[a, 80], [b, 7]]) {
      await assert.rejects(app.authFetch('/api/progress/work', { method: 'PUT', body: JSON.stringify({ ...item, page }) }), /offline/);
    }
    const pending = Object.values(JSON.parse(storage.get('readdeck-progress-reader')));
    assert.equal(pending.length, 2, 'offline writes sharing a chapter UUID keep both resources');
    assert.deepEqual(pending.map(write => [write.body.resourceId, write.body.page]), [['source-a', 80], ['source-b', 7]]);
    const oldQueue = JSON.parse(storage.get('readdeck-progress-reader'));
    oldQueue['/api/progress/work:legacy-chapter'] = {
      url: '/api/progress/work', body: { chapterUuid: 'legacy-chapter', resourceId: 'legacy-resource', page: 3 },
    };
    storage.set('readdeck-progress-reader', JSON.stringify(oldQueue));
    globalThis.fetch = async () => response({});
    app.state.token = 'fixture-token';
    await app.flushPendingProgress();
    assert.deepEqual(JSON.parse(storage.get('readdeck-progress-reader')), {}, 'successful sync retires both current and legacy queue keys');

    const oldProgress = { chapters: { 'shared-volume': { resourceId: b.resourceId, page: 7 } },
      lastResourceId: b.resourceId, lastChapterUuid: a.chapterUuid, lastPage: 7 };
    assert.equal(app.resourceReadingPosition(oldProgress, a), null, 'a matching chapter UUID cannot import another resource page');
    assert.equal(app.resourceReadingPosition(oldProgress, b).page, 7);
    assert.equal(app.resourceReadingPosition({ ...oldProgress, resources: { [a.resourceId]: { resourceId: a.resourceId, page: 80 } } }, a).page, 80);
    assert.equal(app.resourceReadingPosition({ lastResourceId: a.resourceId, lastPage: 42 }, a).page, 42);
    assert.equal(app.resourceReadingPosition({ chapters: { legacy: { page: 3 } } }, { chapterUuid: 'legacy' }).page, 3);

    const nodes = new Map();
    globalThis.document = {
      querySelectorAll: () => [],
      getElementById(id) {
        if (id === 'strip-container') return null;
        if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { remove() {} } });
        return nodes.get(id);
      },
    };
    for (const key of ['_exitNovelMode', '_exitStripMode', 'showPage', 'resetImageZoom', 'loadStripModeForComic',
      'applySettings', 'clearReaderStatus', 'preloadAdjacent']) app[key] = () => {};
    app.withAssetToken = value => value;
    const errors = [];
    app.setReaderStatus = (message, actions) => { if (actions) errors.push(message); };
    const rendered = [];
    app.renderPage = function () {
      rendered.push({ resourceId: this.state.currentChapter.resourceId, page: this.state.currentPage });
      this.saveProgress(this.state.currentPage);
    };
    app.state.novelMode = false;
    app.state.progressCache = {};
    app.state.currentComic.groups = { volumes: [a, b] };
    const images = resourceId => Array.from({ length: resourceId === a.resourceId ? 100 : 20 }, (_, index) => `${resourceId}/page-${index}`);

    // Run real openReader twice with controlled response ordering, including its real queue and save helpers.
    for (const delayedStage of ['progress', 'pages']) {
      const reached = deferred(), release = deferred();
      app.authFetch = async (url, options = {}) => {
        if (options.method === 'PUT') { writes.push({ url, body: JSON.parse(options.body) }); return response({}); }
        const resourceId = url.startsWith('/api/resources/') ? decodeURIComponent(url.split('/')[3]) : new URL(url, 'http://localhost').searchParams.get('resourceId');
        const stage = url.startsWith('/api/resources/') ? 'pages' : 'progress';
        assert([a.resourceId, b.resourceId].includes(resourceId), 'reader fetches progress for the actual resource');
        if (resourceId === a.resourceId && stage === delayedStage) { reached.resolve(); await release.promise; }
        return response(stage === 'pages' ? { pages: images(resourceId) } : {
          resources: { [resourceId]: { resourceId, page: resourceId === a.resourceId ? 80 : 7 } },
        });
      };
      const readingA = app.openReader(a);
      await within(reached.promise);
      await app.openReader(b);
      assert.equal(app.state.currentPage, 7);
      release.resolve();
      await readingA;
      assert.equal(app.state.currentChapter.resourceId, b.resourceId);
      assert.equal(app.state.currentPage, 7, `late A ${delayedStage} must not overwrite B's page`);
      assert.deepEqual(app.state.currentImages, images(b.resourceId), `late A ${delayedStage} must not overwrite B's images`);
      assert.equal(nodes.get('reader-title').textContent, '测试作品 — source-b');
      await app.flushReaderProgress();
      assert.equal(app.state.progressCache.work.resources[b.resourceId].page, 7);
    }
    assert.deepEqual(rendered, [{ resourceId: b.resourceId, page: 7 }, { resourceId: b.resourceId, page: 7 }]);

    for (const scenario of ['rejected-open', 'previous-boundary']) {
      const reached = deferred(), release = deferred();
      app.state.allChapters = [a, b];
      app.state.stripMode = false;
      const renderCount = rendered.length;
      app.authFetch = async (url, options = {}) => {
        if (options.method === 'PUT') { writes.push({ url, body: JSON.parse(options.body) }); return response({}); }
        const isPages = url.startsWith('/api/resources/');
        const resourceId = isPages ? decodeURIComponent(url.split('/')[3]) : new URL(url, 'http://localhost').searchParams.get('resourceId');
        if (resourceId === a.resourceId && isPages) {
          reached.resolve();
          await release.promise;
          if (scenario === 'rejected-open') throw new Error('old resource request failed');
        }
        return response(isPages ? { pages: images(resourceId) } : {
          resources: { [resourceId]: { resourceId, page: resourceId === a.resourceId ? 80 : 7 } },
        });
      };
      const openingA = scenario === 'previous-boundary' ? app.switchChapter(0, 'last') : app.openReader(a);
      await within(reached.promise);
      const oldLoadToken = app._readerLoadToken;
      await app.openReader(b);
      assert.notEqual(app._readerLoadToken, oldLoadToken);
      assert.equal(app.state.currentPage, 7);
      release.resolve();
      await openingA;
      assert.equal(app.state.currentChapter.resourceId, b.resourceId);
      assert.equal(app.state.currentPage, 7, `${scenario} cannot move the new resource to the last page`);
      assert.deepEqual(app.state.currentImages, images(b.resourceId));
      assert.equal(nodes.get('reader-title').textContent, '测试作品 — source-b');
      assert.deepEqual(errors, [], 'a superseded request failure cannot show an error in the current reader');
      assert.equal(rendered.length, renderCount + 1, 'only the new reader renders after the pending request completes');
      await app.flushReaderProgress();
      assert.equal(app.state.progressCache.work.resources[b.resourceId].page, 7);
    }
    assert.deepEqual(errors, []);
    console.log('reader session ok: snapshot saves, EPUB CFI, offline isolation, resource matching, stale responses/errors and superseded boundary navigation');
  } finally {
    if (app._progressTimer) clearTimeout(app._progressTimer);
    for (const key of Object.keys(app)) if (!Object.hasOwn(appDescriptors, key)) delete app[key];
    Object.defineProperties(app, appDescriptors);
    for (const [key, descriptor] of Object.entries(globalDescriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
