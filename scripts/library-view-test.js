const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { app } = require('../public/app');

function createClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add(...names) { names.forEach(name => classes.add(name)); },
    remove(...names) { names.forEach(name => classes.delete(name)); },
    toggle(name, force) {
      if (force === true) classes.add(name);
      else if (force === false) classes.delete(name);
      else if (classes.has(name)) classes.delete(name);
      else classes.add(name);
      return classes.has(name);
    },
    contains(name) { return classes.has(name); },
  };
}

function createElement() {
  const attributes = new Map();
  return {
    classList: createClassList(),
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function main() {
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalLocalStorage = global.localStorage;
  const originalState = { ...app.state };
  const originalRenderComicList = app.renderComicList;
  const originalRenderSearchResults = app.renderSearchResults;
  const originalCloseSortMenu = app.closeSortMenu;
  const originalUpdateSortUI = app.updateSortUI;

  const storage = new Map();
  const elements = {
    'comic-grid': createElement(),
    'library-list-view-btn': createElement(),
    'library-grid-view-btn': createElement(),
    'sort-indicator-text': createElement(),
  };
  const sortArrows = {
    lastRead: { textContent: '' },
    updatedAt: { textContent: '' },
  };
  const sortItems = Object.keys(sortArrows).map(field => ({
    dataset: { sort: field },
    classList: createClassList(),
    querySelector() { return sortArrows[field]; },
  }));
  let listRenders = 0;
  let searchRenders = 0;

  try {
    global.localStorage = {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    };
    global.document = {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll(selector) { return selector === '.sort-menu-item' ? sortItems : []; },
      documentElement: { classList: createClassList() },
    };
    global.window = {
      matchMedia() { return { matches: false }; },
    };
    app.renderComicList = () => { listRenders += 1; };
    app.renderSearchResults = () => { searchRenders += 1; };
    app.closeSortMenu = () => {};
    app.updateSortUI = () => {};

    assert.strictEqual(app.normalizeLibraryViewMode('list'), 'list');
    assert.strictEqual(app.normalizeLibraryViewMode('grid'), 'grid');
    assert.strictEqual(app.normalizeLibraryViewMode('invalid'), 'grid');

    storage.set('libraryViewMode', 'list');
    app.loadSettings();
    assert.strictEqual(app.state.libraryViewMode, 'list', 'saved list mode should be restored');

    storage.set('libraryViewMode', 'broken');
    app.loadSettings();
    assert.strictEqual(app.state.libraryViewMode, 'grid', 'invalid mode should fall back to grid');

    storage.set('comicSortPref', JSON.stringify({ sortBy: 'lastRead', sortOrder: 'asc' }));
    app.loadSettings();
    assert.strictEqual(app.state.sortOrder, 'desc', 'recent-reading sort should ignore legacy ascending preferences');

    app.state.progressCache = {
      readOld: { updatedAt: '2026-01-01T00:00:00.000Z' },
      readNew: { updatedAt: '2026-02-01T00:00:00.000Z' },
    };
    app.state.sortBy = 'lastRead';
    app.state.sortOrder = 'asc';
    const recentSorted = app.getSortedComics([
      { id: 'unreadOld', updatedAt: '2025-01-01' },
      { id: 'readOld', updatedAt: '2025-04-01' },
      { id: 'unreadNew', updatedAt: '2025-03-01' },
      { id: 'readNew', updatedAt: '2025-02-01' },
    ]);
    assert.deepStrictEqual(
      recentSorted.map(item => item.id),
      ['readNew', 'readOld', 'unreadNew', 'unreadOld'],
      'recent-reading sort should always put recent progress first, then recently updated unread books'
    );

    app.updateSortIndicator();
    assert.strictEqual(elements['sort-indicator-text'].textContent, '按最近阅读');
    app.updateSortMenuItems();
    assert.strictEqual(sortArrows.lastRead.textContent, '', 'recent-reading sort should not show an arrow');

    app.changeSort('lastRead');
    assert.strictEqual(app.state.sortOrder, 'desc', 'clicking recent-reading sort should not toggle its order');

    app.state.sortBy = 'updatedAt';
    app.state.sortOrder = 'desc';
    app.changeSort('updatedAt');
    assert.strictEqual(app.state.sortOrder, 'asc', 'other sort fields should keep toggling their order');

    app.updateSortIndicator();
    assert.strictEqual(elements['sort-indicator-text'].textContent, '按更新日期 ↑');
    app.updateSortMenuItems();
    assert.strictEqual(sortArrows.updatedAt.textContent, '↑');

    listRenders = 0;
    searchRenders = 0;
    app.state.libraryViewMode = 'list';
    app.updateLibraryViewUI();
    assert.strictEqual(elements['comic-grid'].dataset.view, 'list');
    assert.strictEqual(elements['comic-grid'].classList.contains('comic-list-view'), true);
    assert.strictEqual(elements['library-list-view-btn'].getAttribute('aria-pressed'), 'true');
    assert.strictEqual(elements['library-grid-view-btn'].getAttribute('aria-pressed'), 'false');

    app.state.searchResults = null;
    app.setLibraryViewMode('grid');
    assert.strictEqual(storage.get('libraryViewMode'), 'grid');
    assert.strictEqual(app.state.libraryViewMode, 'grid');
    assert.strictEqual(listRenders, 1, 'normal library should rerender after changing view');

    app.state.searchResults = [{ id: 'a' }];
    app.state.searchQuery = '测试';
    app.setLibraryViewMode('list');
    assert.strictEqual(searchRenders, 1, 'active search should rerender after changing view');

    app.state.libraryCategory = 'novel';
    app.state.selectedTags = ['轻小说'];
    const currentResults = app.filterBySelectedTags(app.filterByLibraryCategory([
      { id: 'a', category: 'novel', tags: ['轻小说'] },
      { id: 'b', category: 'novel', tags: ['奇幻'] },
      { id: 'c', category: 'comic', tags: ['轻小说'] },
    ]));
    assert.strictEqual(app.libraryCountLabel(currentResults.length), '共 1 本');
    assert.strictEqual(app.libraryCountLabel(0), '共 0 本');

    assert.strictEqual(
      app.formatLibraryProgress({
        lastChapterTitle: '第14册 · 第一话',
        lastResourceType: 'epub',
        lastScrollPercent: 9.4,
      }),
      '第14册 · 第一话 · 9%'
    );
    assert.strictEqual(app.formatLibraryResourceSummary({ resourceCount: 14 }), '共 14 册');

    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(html, /id="library-list-view-btn"[^>]+aria-pressed="false"/);
    assert.match(html, /id="library-grid-view-btn"[^>]+aria-pressed="true"/);
    assert.match(html, /id="sort-indicator-text">按最近阅读<\/span>/);
    assert.match(css, /\.comic-grid\.comic-list-view\s*\{[^}]*display:\s*flex;/s);
    assert.match(css, /\.comic-card:focus-visible/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    assert.match(js, /event\.key !== 'Enter' && event\.key !== ' '/);

    console.log('library view interaction tests passed');
  } finally {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalLocalStorage;
    app.renderComicList = originalRenderComicList;
    app.renderSearchResults = originalRenderSearchResults;
    app.closeSortMenu = originalCloseSortMenu;
    app.updateSortUI = originalUpdateSortUI;
    app.state = originalState;
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
