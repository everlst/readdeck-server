const { spawnSync } = require('node:child_process');
const path = require('node:path');
const suites = [
  "test:scan-discovery",
  "test:web-scrape",
  "test:ai",
  "test:ai-metadata",
  "test:bangumi-search",
  "test:relations",
  "test:debug",
  "test:scrape-log",
  "test:web-search",
  "test:localization",
  "test:settings",
  "test:scan-delta",
  "test:watcher-scan",
  "test:scheduling",
  "test:new-volume-scrape",
  "test:library-refresh",
  "test:library-view",
  "test:detail-presentation",
  "test:work-aggregation",
  "test:reader-ui",
  "test:realtime-events",
  "test:readdeck",
  "test:local-metadata",
  "test:detail-display"
];
const failures = [];
for (const suite of suites) {
  const env = { ...process.env };
  if (suite !== 'test:scheduling') env.NODE_OPTIONS = [env.NODE_OPTIONS, '--require=' + path.join(__dirname, 'fixtures/fast-ai-clock.js')].filter(Boolean).join(' ');
  const result = spawnSync('npm', ['run', suite], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
  if (result.status !== 0) failures.push(suite);
}
if (failures.length) { console.error('Failed suites:', failures.join(', ')); process.exitCode = 1; }
