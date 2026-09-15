const paths = require('./runtimePaths');
const store = require('./settingsStore');
const scrapeContext = require('./scrapeContext');

// Scrape metadata/credentials use task snapshots; topology and global limits stay live.
module.exports = {
  ...paths,
  get LIBRARY_SOURCES() { return store.snapshot().sources.filter(s => s.enabled); },
  get LIBRARY_CATEGORIES() {
    const settings = store.snapshot();
    return settings.categories.map(c => ({
      key: c.id, label: c.label, visible: c.visible, builtin: ['comic', 'novel', 'other'].includes(c.id),
      pathBound: !['comic', 'novel'].includes(c.id),
      paths: settings.sources.filter(s => s.enabled && s.mode === 'fixed' && s.categoryId === c.id).map(s => s.path),
    }));
  },
  get LIBRARY_WATCH_DIRS() { return this.LIBRARY_SOURCES.map(s => s.path); },
  get PATH_BOUND_LIBRARY_CATEGORY_KEYS() { return new Set(this.LIBRARY_CATEGORIES.filter(c => c.pathBound).map(c => c.key)); },
  get PATH_BOUND_LIBRARY_CATEGORIES() { return this.LIBRARY_CATEGORIES.filter(c => c.pathBound); },
  get READER_CACHE_MAX_SIZE_MB() { return store.snapshot().cache.maxSizeMb; },
  get READER_CACHE_MAX_RESOURCES() { return store.snapshot().cache.maxResources; },
  get READER_CACHE_TTL_MINUTES() { return store.snapshot().cache.ttlMinutes; },
  READER_CACHE_ACTIVE_GRACE_MINUTES: 360,
  IMAGE_MAX_DIMENSION: 4096, PDF_RENDER_DPI: 160, PRELOAD_PAGE_COUNT: 3,
  ARCHIVE_UPDATE_INTERVAL_HOURS: 168,
  BANGUMI_USER_AGENT: 'reader-plus-comicreader/2.1 (+https://bangumi.tv)',
  SCAN_LIBRARY_CONCURRENCY: 4, BANGUMI_FETCH_CONCURRENCY: 4,
  get SCRAPE_SERIES_CONCURRENCY() { return store.snapshot().scanning.scrapeConcurrency; },
  get AI_MAX_CONCURRENCY() { return store.snapshot().metadata.aiConcurrency; },
  get AI_WEB_SEARCH_ENABLED() { return scrapeContext.metadataSettings().aiWebSearchEnabled; },
  get BANGUMI_ACCESS_TOKEN() { return scrapeContext.credential('bangumiToken'); },
  get AI_API_KEY() { return scrapeContext.credential('aiApiKey'); },
  get AI_BASE_URL() { return scrapeContext.metadataSettings().aiBaseUrl; },
  get AI_MODEL() { return scrapeContext.metadataSettings().aiModel; },
  get AI_REASONING_EFFORT() { return scrapeContext.metadataSettings().aiReasoningEffort; },
  // Legacy matching helpers keep their names to preserve cached metadata and integrations.
  get DEEPSEEK_API_KEY() { return this.AI_API_KEY; },
  get DEEPSEEK_BASE_URL() { return this.AI_BASE_URL; },
  get DEEPSEEK_MODEL() { return this.AI_MODEL; },
  get DEEPSEEK_MATCH_ENABLED() { return scrapeContext.metadataSettings().matchEnabled; },
  get DEEPSEEK_VOLUME_MATCH_ENABLED() { return scrapeContext.metadataSettings().volumeMatchEnabled; },
  get DEEPSEEK_LOCAL_GROUP_ENABLED() { return scrapeContext.metadataSettings().localGroupEnabled; },
  DEEPSEEK_MATCH_MIN_CONFIDENCE: 70, DEEPSEEK_VOLUME_MATCH_MIN_CONFIDENCE: 70,
  DEEPSEEK_RELATED_MATCH_MIN_CONFIDENCE: 70, DEEPSEEK_LOCAL_GROUP_MIN_CONFIDENCE: 85,
};
