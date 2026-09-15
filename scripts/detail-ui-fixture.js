// Isolated data for browser/iPhone verification; never scans the user's library.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { prepareSettings, fixtureSource } = require('./settings-fixture');

async function start({ port = 15947 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-detail-fixture-'));
  process.env.DATA_DIR = path.join(root, 'data');
  const library = path.join(root, 'library');
  await fs.mkdir(library);
  prepareSettings({ dataRoot: process.env.DATA_DIR, sources: [fixtureSource(library)] });
  const metadata = require('../lib/metadataStore');
  const users = require('../lib/userStore');
  users.initialize();
  const reader = await users.save(null, { username: 'detail-reader', password: 'test-password', role: 'reader', sourceIds: ['fixture-source'] });
  await users.updateAccount(reader.id, { currentPassword: 'test-password', password: 'reader-password', username: 'detail-reader' });
  const work = { seriesId: 'detail-qa', title: '作品详情验收', authors: ['ReadDeck'], category: 'comic', tags: ['测试'], brief: '用于检查横向滑动、人物详情与账号显示设置。', bangumiSubjectId: 303952 };
  const resources = [];
  for (let index = 1; index <= 8; index++) {
    const volume = index > 6, name = volume ? `第${index - 6}册` : `第${String(index).padStart(2, '0')}话`;
    const directory = path.join(library, 'Work', String(index));
    await fs.mkdir(directory, { recursive: true });
    await sharp({ create: { width: 480, height: 680, channels: 3, background: volume ? '#516b79' : '#c8b49a' } }).png().toFile(path.join(directory, '1.png'));
    resources.push({ resourceId: 'detail-resource-' + index, seriesId: work.seriesId, sourceId: 'fixture-source', sourcePath: directory,
      relativePath: 'Work/' + index, seriesRelativePath: 'Work', title: name, originalTitle: name, type: 'directory',
      contentType: volume ? 'volume' : 'chapter', detectedNumber: volume ? index - 6 : index,
      detectedNumberType: volume ? 'volume' : 'chapter', category: 'comic', pageCount: 1, readable: true });
  }
  const image = id => `/api/resources/detail-resource-${id}/cover`;
  const characters = [
    { characterId: 170189, name: 'カムイ', nameCn: '神威', role: '主角', image: 'https://lain.bgm.tv/pic/crt/l/7b/3d/170189_crt_zNJye.jpg' },
    { characterId: 170190, name: '耳塚シヅカ', nameCn: '耳塚志津香', role: '主角', image: 'https://lain.bgm.tv/pic/crt/l/19/d4/170190_crt_ZBbUC.jpg' },
    { characterId: 209835, nameCn: '阿市', role: '配角', image: 'https://lain.bgm.tv/pic/crt/l/0e/92/209835_crt_BDOCb.jpg' },
    { characterId: 209838, nameCn: '响子', role: '配角', image: 'https://lain.bgm.tv/pic/crt/l/f8/ba/209838_crt_Ux9ku.jpg' },
    { metadataKey: 'local:missing-character', nameCn: '很长的角色姓名用于两行展示', role: '配角', image: '' },
    { metadataKey: 'local:web-character', nameCn: '无 Bangumi 角色', role: '配角', sourceUrl: 'https://example.org/character' },
  ];
  characters[0].summary = 'これは表示確認用の原文です。\n段落と長い紹介を表示します。';
  characters[0].translatedSummary = '这段简介用于界面显示验收。\n\n人物详情页展示完整内容，并保留清晰的段落间距。点击下方“查看原文”可以核对原始简介。';
  const persons = [
    { personId: 37547, nameCn: 'コノシロしんこ', position: '作画', image: 'https://lain.bgm.tv/pic/crt/l/63/69/37547_prsn_GxTsv.jpg', summary: '创作人员的简介。' },
    { personId: 6749, nameCn: '小学馆', position: '出版社', image: 'https://lain.bgm.tv/pic/crt/l/2c/ec/6749_prsn_HWCuf.jpg', summary: '出版社资料。' },
    { metadataKey: 'local:author', nameCn: '无头像作者', position: '原作', sourceUrl: 'https://example.org/author' },
    { personId: 22488, nameCn: 'MangaONE', position: '连载杂志', image: 'https://lain.bgm.tv/pic/crt/l/01/7f/22488_prsn_BBZAP.jpg' },
  ];
  const relations = [{ metadataKey: 'relation-one', nameCn: '关联外传', relationType: '外传', sourceUrl: 'https://example.org/related', image: image(7) }];
  const bangumi = { subjectId: 303952, name_cn: work.title, name: 'UI fixture', summary: work.brief,
    persons, characters, relatedSubjects: relations, webScrape: { status: 'success', completedAt: new Date().toISOString() } };
  await metadata.writeSeriesBundle(work, resources, { bangumi, persons, characters, relations });
  await metadata.rebuildIndexes([work], resources);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  for (let count = 0; count < 150 && !logs.includes('ReadDeck running'); count++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!logs.includes('ReadDeck running')) { child.kill(); throw new Error(logs); }
  const close = async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await fs.rm(root, { recursive: true, force: true }); };
  return { child, root, base: `http://127.0.0.1:${port}`, readerId: reader.id, close };
}
if (require.main === module) start({ port: Number(process.env.READDECK_DETAIL_PORT || 15947) }).then(fixture => {
  console.log(`Detail fixture ready: ${fixture.base} (admin/test-password or detail-reader/reader-password)`);
  const stop = () => fixture.close().then(() => process.exit());
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { start };
