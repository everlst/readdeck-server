// Offline, disposable library for HTTP regressions and browser verification.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

const seriesId = 'reader-navigation-a';
const credentials = { username: 'admin', password: 'test-password' };
const readerCredentials = { username: 'source-a-reader', password: 'reader-password' };

async function start({ port = 15948 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-reader-navigation-'));
  const dataRoot = path.join(root, 'data');
  const library = path.join(root, 'library');
  process.env.DATA_DIR = dataRoot;
  let child;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    const sources = ['a', 'b'].map((source, order) => fixtureSource(path.join(library, source), {
      id: `source-${source}`, name: `来源 ${source.toUpperCase()}`, order,
    }));
    await Promise.all(sources.map(source => fs.mkdir(source.path, { recursive: true })));
    prepareSettings({ dataRoot, sources, ...credentials });
    const metadata = require('../lib/metadataStore');
    const users = require('../lib/userStore');
    users.initialize();
    const reader = await users.save(null, {
      ...readerCredentials, role: 'reader', sourceIds: ['source-a'],
    });
    await users.updateAccount(reader.id, {
      currentPassword: readerCredentials.password, password: readerCredentials.password,
      username: readerCredentials.username,
    });

    const relations = Array.from({ length: 6 }, (_, index) => ({
      subjectId: 910001 + index, relationType: '单行本', order: index + 1,
      name_cn: `导航测试 第${index + 1}册`,
    }));
    for (const source of sources) {
      const letter = source.id.endsWith('a') ? 'a' : 'b';
      const sourceSeriesId = `reader-navigation-${letter}`;
      const numbers = letter === 'a' ? [1, 2, 3, 4, 6] : [1, 2, 3, 4, 5];
      const items = numbers.map(number => ({ number, contentType: 'volume' }));
      // Two ordinary chapters are intentionally present outside the volume queue.
      if (letter === 'a') items.push(...[1, 2].map(number => ({ number, contentType: 'chapter' })));
      const resources = [];
      for (const { number, contentType } of items) {
        const resourceId = contentType === 'volume' ? `${letter}${number}` : `chapter-${number}`;
        const directory = path.join(source.path, 'Navigation', resourceId);
        const pageCount = resourceId === 'a1' ? 3 : 2;
        await fs.mkdir(directory, { recursive: true });
        for (let page = 1; page <= pageCount; page++) {
          const background = letter === 'a' ? '#d9c6a3' : '#a3bfd9';
          const svg = `<svg width="480" height="680"><rect width="480" height="680" fill="${background}"/><text x="240" y="300" text-anchor="middle" font-size="64">${resourceId.toUpperCase()}</text><text x="240" y="400" text-anchor="middle" font-size="40">Page ${page}</text></svg>`;
          await sharp(Buffer.from(svg)).png().toFile(path.join(directory, `${page}.png`));
        }
        resources.push({
          resourceId, seriesId: sourceSeriesId, sourceId: source.id, sourcePath: directory,
          relativePath: `Navigation/${resourceId}`, seriesRelativePath: 'Navigation',
          title: contentType === 'volume' ? `${letter.toUpperCase()} 第${number}册` : `第${number}话`,
          originalTitle: resourceId, type: 'directory', contentType,
          detectedNumber: number, detectedNumberType: contentType, category: 'comic',
          groupKey: contentType === 'chapter' ? 'default' : '',
          groupName: contentType === 'chapter' ? '单话' : '',
          pageCount, readable: true, coverCandidate: `/api/resources/${resourceId}/cover`,
        });
      }
      const series = {
        seriesId: sourceSeriesId, title: '阅读导航测试', category: 'comic',
        source: source.name, authors: ['ReadDeck'], contentMode: 'mixed',
        bangumiSubjectId: 910000, hasVolumes: true, hasChapters: letter === 'a',
        brief: '来源 A：1、2、3、4、6 册；来源 B：1、2、3、4、5 册。',
        cover: `/api/resources/${letter}1/cover`,
      };
      const written = await metadata.writeSeriesBundle(series, resources, {
        bangumi: {
          subjectId: 910000, name_cn: series.title, summary: series.brief,
          relatedSubjects: relations, detailsSchemaVersion: 2,
          volumeMatches: numbers.map(number => ({
            resourceId: `${letter}${number}`, matched: true, subjectId: 910000 + number,
            matchKind: 'offprint', relationType: '单行本', displayTitle: `第${number}册`,
            bangumiOrder: number,
          })),
        },
        relations, persons: [], characters: [], translations: [],
        volumeDetails: Object.fromEntries(numbers.map(number => [String(910000 + number), {
          subjectId: 910000 + number, nameCn: `第${number}册`,
          summary: `第${number}册离线测试资料。`, cover: `/api/resources/${letter}${number}/cover`,
        }])),
      });
      await metadata.upsertSeriesIndexes(written, resources);
    }

    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataRoot, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Fixture startup timed out: ${logs}`)), 15000);
      const onData = () => { if (logs.includes('ReadDeck running')) finish(); };
      const onExit = code => finish(new Error(`Fixture server exited (${code}): ${logs}`));
      const onError = error => finish(error);
      function finish(error) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
        error ? reject(error) : resolve();
      }
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
    return { child, root, dataRoot, base: `http://127.0.0.1:${port}`, seriesId,
      credentials, readerCredentials, readerId: reader.id, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (require.main === module) {
  start({ port: Number(process.env.READDECK_NAVIGATION_PORT || 15948) }).then(fixture => {
    console.log(`Reader navigation fixture: ${fixture.base} (${credentials.username}/${credentials.password})`);
    console.log(`Source A reader: ${readerCredentials.username}/${readerCredentials.password}`);
    const stop = () => fixture.close().then(() => process.exit());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { start };
