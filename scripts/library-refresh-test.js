const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app } = require('../public/app');

function comic(id, name = id) {
  return { id, name, category: 'comic' };
}

function response(payload, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => payload };
}

async function main() {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const headerRule = styles.match(/\.main-header\s*\{([\s\S]*?)\}/)?.[1] || '';
  const sortAnchorRule = styles.match(/\.sort-anchor\s*\{([\s\S]*?)\}/)?.[1] || '';
  const headerZIndex = Number(headerRule.match(/z-index:\s*(\d+)/)?.[1] || 0);
  const sortAnchorZIndex = Number(sortAnchorRule.match(/z-index:\s*(\d+)/)?.[1] || 0);
  assert(headerZIndex > sortAnchorZIndex,
    'the sticky header must stay above the scrolling sort bar');

  app.state.comics = [comic('a', 'A old'), comic('b', 'B')];
  app.state.comicsRefreshSequence = 0;
  app.state.comicsAppliedSequence = 0;
  app.state.searchResults = null;
  app.state.searchQuery = '';
  app.state.searchRefreshSequence = 0;
  app.state.searchAppliedSequence = 0;
  app.state.libraryCategory = 'comic';
  app.renderTagFilter = () => {};
  app.renderComicList = () => {};
  app.renderSearchResults = () => {};

  const merged = app.mergeComicSnapshots(
    app.state.comics,
    [comic('a', 'A updated'), comic('c', 'C')],
    false
  );
  assert.deepStrictEqual(merged.map(item => item.id), ['a', 'b', 'c']);
  assert.strictEqual(merged[0].name, 'A updated', 'incoming data should update an existing card in place');

  const pending = [];
  app.authFetch = () => new Promise(resolve => pending.push(resolve));
  const olderRequest = app.refreshComicsIncremental({ authoritative: false });
  const newerRequest = app.refreshComicsIncremental({ authoritative: false });

  pending[0](response([comic('a', 'A stale')]));
  const olderResult = await olderRequest;
  assert.strictEqual(olderResult.applied, false, 'an older response must be ignored once a newer request starts');
  assert.deepStrictEqual(app.state.comics.map(item => item.id), ['a', 'b']);

  pending[1](response([comic('a', 'A newest'), comic('c', 'C')]));
  await newerRequest;

  assert.deepStrictEqual(
    app.state.comics.map(item => item.id),
    ['a', 'b', 'c'],
    'the latest non-authoritative response should update and append without removing old cards'
  );
  assert.strictEqual(app.state.comics[0].name, 'A newest');

  app.authFetch = async () => response({ error: 'boom' }, false);
  const originalConsoleError = console.error;
  let failedRefresh;
  try {
    console.error = () => {};
    failedRefresh = await app.refreshComicsIncremental({ authoritative: true });
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(failedRefresh.success, false);
  assert.deepStrictEqual(
    app.state.comics.map(item => item.id),
    ['a', 'b', 'c'],
    'an HTTP error must never be interpreted as an empty authoritative library'
  );

  app.authFetch = async () => response([comic('a', 'A final'), comic('c', 'C')]);
  await app.refreshComicsIncremental({ authoritative: true });
  assert.deepStrictEqual(
    app.state.comics.map(item => item.id),
    ['a', 'c'],
    'the authoritative snapshot should apply real removals once scanning is complete'
  );

  app.state.searchQuery = '测试';
  app.state.searchResults = [comic('a', 'old comic result')];
  const searchPending = [];
  app.authFetch = () => new Promise(resolve => searchPending.push(resolve));
  const comicSearch = app.performSearch('测试');
  app.state.libraryCategory = 'novel';
  const novelSearch = app.performSearch('测试');
  searchPending[0](response([comic('b', 'stale comic category')]));
  await comicSearch;
  assert.deepStrictEqual(app.state.searchResults.map(item => item.id), ['a'],
    'results from the previous category must be ignored');
  searchPending[1](response([comic('n', 'novel result')]));
  await novelSearch;
  assert.deepStrictEqual(app.state.searchResults.map(item => item.id), ['n']);

  app.state.scanSnapshotCommittedTaskId = 0;
  const runningScan = { id: 7, type: 'scanAndScrape', progress: { scanDone: false } };
  const committedScan = { id: 7, type: 'scanAndScrape', progress: { scanDone: true } };
  assert.strictEqual(app.taskSnapshotIsAuthoritative(runningScan), false);
  assert.strictEqual(app.taskSnapshotIsAuthoritative(committedScan), true);
  app.state.scanSnapshotCommittedTaskId = 7;
  assert.strictEqual(app.taskSnapshotIsAuthoritative(committedScan), false,
    'a successfully committed scan snapshot should not be applied authoritatively twice');

  let realtimeRefreshes = 0;
  app.scheduleRealtimeLibraryRefresh = () => { realtimeRefreshes += 1; };
  app.state.currentComic = null;
  app.handleRealtimeLibraryEvent({ reason: 'series_bundle_written', payload: { seriesId: 'a' } });
  assert.strictEqual(realtimeRefreshes, 0,
    'bundle writes should wait for a committed derived index before refreshing the list');
  app.handleRealtimeLibraryEvent({ reason: 'derived_indexes_written', payload: {} });
  assert.strictEqual(realtimeRefreshes, 1,
    'a pushed derived-index event should refresh the library automatically');

  const originalDocument = global.document;
  const originalEventSource = global.EventSource;
  const status = { textContent: '', style: { display: 'none' } };
  global.document = { getElementById: id => id === 'task-status' ? status : null };
  for (const [type, name] of Object.entries({ scanLibrary: '扫描书库', scrapeSeries: '刮削作品信息', scanAndScrape: '扫描并刮削书库', updateArchive: '更新元数据档案', futureTask: '后台任务' })) {
    for (const [state, label] of Object.entries({ queued: '等待中', running: '进行中', success: '已完成', failed: '失败', cancelled: '已取消', futureState: '未知状态' })) {
      const task = { id: 8, type, status: state, error: state === 'failed' ? '测试失败原因' : '' };
      app.applyRealtimeTaskSnapshot([task]);
      assert.strictEqual(status.textContent, `${name}：${label}${task.error ? ' · ' + task.error : ''}`);
      assert.strictEqual(status.textContent, app.taskSummary(task), 'SSE and polling must use the same localized summary');
    }
  }
  clearTimeout(app.state.realtimeStatusHideTimer);
  app.applyRealtimeTaskSnapshot([{
    id: 9,
    type: 'scanAndScrape',
    status: 'running',
    progress: {
      scanDone: true,
      discovered: 0,
      completed: 0,
      total: 1,
      success: 0,
      failed: 0,
      volumeOnlyTotal: 1,
    },
  }]);
  assert.match(status.textContent, /新增卷 1/,
    'pushed task progress should identify targeted new-volume scraping');

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      FakeEventSource.instance = this;
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    close() {
      this.closed = true;
    }
    emit(name, data = {}) {
      this.listeners.get(name)?.({ data: JSON.stringify(data) });
    }
  }
  global.EventSource = FakeEventSource;
  app.state.token = 'realtime-token';
  assert.strictEqual(app.connectRealtimeEvents(), true);
  assert.match(FakeEventSource.instance.url, /\/api\/events\?token=realtime-token/);
  FakeEventSource.instance.emit('open');
  assert.strictEqual(app.state.realtimeConnected, true);
  app.disconnectRealtimeEvents();
  assert.strictEqual(FakeEventSource.instance.closed, true);
  global.document = originalDocument;
  global.EventSource = originalEventSource;

  console.log('library refresh ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
