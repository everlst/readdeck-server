const assert = require('assert');
const fs = require('fs').promises;
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

function createElement(options = {}) {
  return {
    style: { display: options.display || '' },
    classList: createClassList(options.classes || []),
    value: '',
    textContent: '',
    checked: false,
    innerHTML: '',
    appendChild() {},
    querySelectorAll() { return []; },
  };
}

async function main() {
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalApplyNovelTypography = app.applyNovelTypography;
  const originalApplyNovelModeClass = app.applyNovelModeClass;
  const originalState = { ...app.state };
  let appHeight = '';
  let viewportBottom = '';
  let visualViewportResize;
  let visualViewportScroll;

  const elements = {
    'double-page-mode': createElement(),
    'strip-mode': createElement(),
    'novel-font-select': createElement(),
    'novel-font-size-value': createElement(),
    'page-slider': createElement(),
    'toggle-offset-btn': createElement(),
    'double-page-row': createElement(),
    'direction-row': createElement(),
    'strip-mode-row': createElement(),
    'novel-mode-row': createElement(),
    'novel-font-row': createElement(),
    'novel-font-size-row': createElement(),
    'novel-toc-btn': createElement(),
    'novel-toc-panel': createElement({ display: 'none' }),
    'novel-toc-backdrop': createElement({ display: 'none' }),
    'novel-toc-list': createElement(),
    'reader-ui': createElement({ classes: ['visible'] }),
    'settings-panel': createElement({ classes: ['active'] }),
  };

  try {
    global.document = {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll() { return []; },
      documentElement: {
        clientHeight: 900,
        style: {
          setProperty(name, value) {
            if (name === '--app-height') appHeight = value;
            if (name === '--visual-viewport-bottom') viewportBottom = value;
          },
        },
      },
    };
    global.window = {
      innerHeight: 900,
      addEventListener() {},
      visualViewport: {
        height: 720,
        offsetTop: 20,
        addEventListener(name, handler) {
          if (name === 'resize') visualViewportResize = handler;
          if (name === 'scroll') visualViewportScroll = handler;
        },
      },
    };
    app.applyNovelTypography = () => {};
    app.applyNovelModeClass = () => {};
    Object.assign(app.state, {
      allChapters: [],
      doublePageMode: true,
      novelMode: true,
      stripMode: false,
      uiVisible: true,
    });

    app._setupViewportHeight();
    assert.strictEqual(appHeight, '720px', 'reader height should use the visible mobile viewport');
    assert.strictEqual(viewportBottom, '160px', 'viewport obstruction should reserve the covered bottom region');
    global.window.visualViewport.height = 680;
    visualViewportResize();
    assert.strictEqual(appHeight, '680px', 'reader height should track visual viewport changes');
    assert.strictEqual(viewportBottom, '200px');
    global.window.visualViewport.offsetTop = 30;
    visualViewportScroll();
    assert.strictEqual(viewportBottom, '190px', 'viewport scrolling should track browser chrome movement');
    global.window.visualViewport.height = 0;
    visualViewportResize();
    assert.strictEqual(appHeight, '900px', 'reader height should fall back when visual viewport is unavailable');
    assert.strictEqual(viewportBottom, '0px');

    app.applySettings();
    assert.strictEqual(
      elements['toggle-offset-btn'].style.display,
      'none',
      'novel reader must hide the comic spread-offset button'
    );

    app.state.novelMode = false;
    app.applySettings();
    assert.strictEqual(
      elements['toggle-offset-btn'].style.display,
      'flex',
      'comic reader should keep the spread-offset button when spread mode is enabled'
    );

    app.state.novelMode = true;
    app.toggleNovelToc(true);
    assert.strictEqual(elements['novel-toc-panel'].style.display, 'flex');
    assert.strictEqual(elements['novel-toc-backdrop'].style.display, 'block');

    app.dismissNovelToc();
    assert.strictEqual(elements['novel-toc-panel'].style.display, 'none');
    assert.strictEqual(elements['novel-toc-backdrop'].style.display, 'none');
    assert.strictEqual(app.state.uiVisible, false);
    assert.strictEqual(elements['reader-ui'].classList.contains('visible'), false);
    assert.strictEqual(elements['settings-panel'].classList.contains('active'), false);

    const html = await fs.readFile(path.resolve(__dirname, '../public/index.html'), 'utf8');
    const css = await fs.readFile(path.resolve(__dirname, '../public/styles.css'), 'utf8');
    assert.match(html, /id="novel-toc-backdrop"[^>]+onclick="app\.dismissNovelToc\(\)"/);
    assert.match(html, /class="icon-btn novel-toc-close-btn"[^>]+aria-label="关闭"[^>]*>\s*<svg/s);
    assert.match(css, /#reader-page\.active\s*\{[^}]*height:\s*var\(--app-height, 100vh\);[^}]*min-height:\s*0;/s);
    assert.match(css, /\.page\s*\{[^}]*min-height:\s*100dvh;[^}]*--visual-viewport-bottom\)\)\);/s);
    assert.match(css, /html\.reader-active,[\s\S]*body\.reader-active\s*\{[^}]*overscroll-behavior:\s*none;/s);
    assert.match(css, /\.novel-toc-backdrop\s*\{[^}]*z-index:\s*229;[^}]*touch-action:\s*manipulation;/s);
    assert.match(css, /\.novel-toc-list\s*\{[^}]*padding:\s*\.4rem 0 max\(\.4rem, var\(--safe-bottom\)\);[^}]*min-height:\s*0;[^}]*overscroll-behavior-y:\s*contain;/s);
    assert.match(css, /\.novel-toc-close-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  } finally {
    global.document = originalDocument;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    app.applyNovelTypography = originalApplyNovelTypography;
    app.applyNovelModeClass = originalApplyNovelModeClass;
    app.state = originalState;
  }

  console.log('reader ui interaction tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
