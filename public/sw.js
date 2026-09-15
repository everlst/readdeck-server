const CACHE_NAME = 'readdeck-v2-detail';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/system-settings.js',
  '/system-settings.css',
  '/detail-preferences.js',
  '/detail-presentation.css',
  '/vendor/epub.min.js',
  '/vendor/jszip.min.js',
  '/fonts/reader-plus-kai-punctuation.ttf',
  '/manifest.json',
  '/icon-192.svg'
];

// 安装：缓存静态资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求策略：
// - API 普通请求：网络直连（不缓存）
// - API 图片同样重新验证权限，不在 Service Worker 中保存
// - 页面导航：网络优先，离线回退 index.html
// - 其他静态资源：stale-while-revalidate（先读缓存，再后台更新）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // API 请求始终走网络（保持鉴权逻辑）
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // 页面导航：优先拿最新 HTML，失败再读缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 其他静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});
