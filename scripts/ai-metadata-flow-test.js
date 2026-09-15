const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareSettings } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-ai-flow-'));
  process.env.DATA_DIR = path.join(root, 'data');
  const library = path.join(root, 'library');
  await fs.mkdir(library);
  prepareSettings({ dataRoot: process.env.DATA_DIR, libraryRoot: library });
  const config = require('../lib/config');
  const metadata = require('../lib/metadataStore');
  const { scanLibrary } = require('../lib/scanner');
  const { parseNameWithAI } = require('../lib/aiNameParser');
  const archive = require('../lib/archiveSource');
  const { localizeFallbackMetadata } = require('../lib/fallbackLocalization');
  const originalFetch = global.fetch;
  let parseCalls = 0, invalidParse = false, invalidFallback = false, verdict = true;
  const parsed = { title: 'AI识别的作品', authors: ['正确作者'], alternateTitles: [], publishers: [], status: '未完', tags: [],
    contentType: 'chapter', detectedNumber: 5.5, detectedNumberEnd: 5.5, detectedNumberType: 'chapter' };
  const candidate = { id: 100, type: 1, name: 'AI识别的作品', name_cn: 'AI识别的作品', infobox: { 作者: '正确作者' }, summary: '' };
  const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  try {
    const file = path.join(library, '[错误标题][作者][Vol.01].epub');
    await fs.writeFile(file, 'fast scan fixture');
    const first = await scanLibrary({ fast: true });
    const oldId = first.seriesList[0].seriesId;
    for (const [key, value] of Object.entries({ AI_API_KEY: 'synthetic-key', AI_MODEL: 'test-model', DEEPSEEK_MATCH_ENABLED: true,
      DEEPSEEK_LOCAL_GROUP_ENABLED: false, DEEPSEEK_VOLUME_MATCH_ENABLED: true })) {
      Object.defineProperty(config, key, { configurable: true, value });
    }
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('api.bgm.tv')) return response(String(url).includes('/search/') ? { data: [candidate] } : candidate);
      const body = JSON.parse(options.body), payload = JSON.parse(body.messages.at(-1).content);
      if (payload.task === 'parse_resource_name') {
        parseCalls++;
        return response({ choices: [{ message: { content: JSON.stringify(invalidParse ? { title: 'bad' } : parsed) } }] });
      }
      let result;
      if (payload.task === 'choose_best_bangumi_book_subject') {
        assert(!('ruleScores' in payload.candidates[0]));
        result = { matched: verdict, subjectId: verdict ? payload.candidates[0].subjectId : null, confidence: 3, reason: 'AI已完成作品形态与标题语义校验' };
      } else if (payload.task === 'suggest_bangumi_book_search_keywords') result = { keywords: ['AI识别的作品'] };
      else if (payload.task === 'localize_failed_metadata') {
        result = { results: invalidFallback ? [] : payload.entries.map(entry => ({ key: entry.key,
          text: entry.key === 'series.title' ? '药屋少女的呢喃画集' : entry.key.includes('authors') ? '日向夏' : '已有资料的简体中文内容' })) };
      } else throw new Error('unexpected AI task: ' + payload.task);
      return response({ choices: [{ message: { content: JSON.stringify(result) } }] });
    };
    const second = await scanLibrary({ fast: true });
    assert.equal(second.seriesList[0].seriesId, oldId, 'AI parsing must preserve an existing resource’s series ID');
    assert.equal(second.seriesList[0].title, first.seriesList[0].title);
    assert.equal(second.resourceList[0].contentType, 'volume');
    assert.equal(second.resourceList[0].detectedNumber, 1);
    assert.equal(parseCalls, 0);
    await scanLibrary({ fast: true });
    assert.equal(parseCalls, 0, 'scanning never reads or writes AI parsing results');
    await Promise.all([parseNameWithAI('another.cbz'), parseNameWithAI('another.cbz')]);
    assert.equal(parseCalls, 1, 'concurrent identical non-scan parsing requests must merge');
    invalidParse = true;
    const beforeBadScan = await metadata.readLibraryIndexes();
    await fs.writeFile(path.join(library, '新增文件.cbz'), 'new file');
    await scanLibrary({ fast: true });
    const afterBadParse = await metadata.readLibraryIndexes();
    for (const [id, resource] of Object.entries(beforeBadScan.resourceIndex)) assert.deepEqual(afterBadParse.resourceIndex[id], resource);
    assert(Object.values(afterBadParse.resourceIndex).some(resource => resource.sourcePath.endsWith('新增文件.cbz')),
      'optional AI parsing failure must fall back locally and publish the discovered file');
    await assert.rejects(parseNameWithAI('bad.cbz'), /AI 文件名解析/);
    invalidParse = false;
    const retried = await parseNameWithAI('bad.cbz');
    assert.equal(retried.title, parsed.title, 'invalid responses must not poison the parse cache');

    const chosen = await archive.chooseSubjectWithDeepSeek({ title: '完全不同的地方译名', category: 'comic' },
      [{ ...candidate, _titleScore: 0, _strictMatch: false }]);
    assert.equal(chosen.id, 100, 'a valid AI decision must not be vetoed by program title scores or confidence thresholds');
    verdict = false;
    await assert.rejects(archive.scrapeSeries(oldId, { force: true }), /未找到 Bangumi 匹配/,
      'AI rejection must not fall back to a rule match');
    const volume = archive.parseDeepSeekVolumeMatchResponse(JSON.stringify({ results: [
      { resourceKey: 'volume', matched: true, subjectId: 101, confidence: 1, displayTitle: '番外篇' },
      { resourceKey: 'other', matched: true, subjectId: 999, confidence: 100, displayTitle: '其他' },
    ] }), [{ resourceId: 'volume' }, { resourceId: 'other' }], [{ subjectId: 101, name_cn: '番外篇' }]);
    assert.equal(volume[0].subjectId, 101); assert.equal(volume[1].subjectId, null);
    assert.equal(archive.parseDeepSeekSubjectMatchResponse('{"matched":true,"subjectId":999,"confidence":100}', [candidate]), null);

    const bundle = await metadata.readSeriesBundle(oldId);
    await metadata.writeSeriesBundle({ ...bundle.series, title: '薬屋のひとりごと画集', authors: ['日向夏'], brief: '少女の物語です。' }, bundle.resources);
    const unchanged = await metadata.readSeriesBundle(oldId);
    invalidFallback = true;
    await assert.rejects(archive.fallbackBangumiToLocalMode(oldId, { persistAsScrapeResult: true }), /未覆盖现有元数据/);
    assert.deepEqual(await metadata.readSeriesBundle(oldId), unchanged, 'incomplete localization must not overwrite existing metadata');
    invalidFallback = false;
    const fallbackResult = await archive.scrapeSeries(oldId);
    assert.match(fallbackResult.fallbackFromError, /未找到 Bangumi 匹配/, 'a saved fallback must retain the scrape failure for task summaries');
    const localized = await metadata.readSeriesBundle(oldId);
    assert.equal(localized.series.title, '药屋少女的呢喃画集');
    assert.equal(localized.series.brief, '已有资料的简体中文内容');
    assert.equal(localized.bangumi.subjectId, null);
    assert.equal(localized.bangumi.fallbackLocalization.provider, 'ai_translation');
    assert.equal(localized.resources[0].sourcePath, file, 'localization must not rename source files');
    assert.equal(localized.resources[0].contentType, unchanged.resources[0].contentType);
    const descriptor = await archive.resolveMetadataOnly({ title: '薬屋のひとりごと画集', author: '日向夏', originalName: '画集.cbz', mediaType: 'comic' });
    assert.equal(descriptor.fallback, true); assert.equal(descriptor.subjectId, null); assert.equal(descriptor.title, '药屋少女的呢喃画集');
    assert.equal((await localizeFallbackMetadata({ title: '原名', authors: [] })).series.title, '药屋少女的呢喃画集');

    // Force must re-run every stage even when the old ID, override, shared result and volume cache all exist.
    Object.assign(parsed, { contentType: 'volume', detectedNumberType: 'volume' });
    Object.defineProperty(config, 'AI_WEB_SEARCH_ENABLED', { configurable: true, value: false });
    const existing = await metadata.readSeriesBundle(oldId);
    existing.resources = existing.resources.map(resource => ({ ...resource, contentType: 'volume', detectedNumberType: 'volume' }));
    const staleBangumi = { subjectId: 900, name: '旧匹配', name_cn: '旧译名', authors: ['旧作者'],
      localizationVersion: 3, detailsSchemaVersion: 2, translatedSummary: '旧简介', volumeMatches: [{
        resourceId: existing.resources[0].resourceId, subjectId: 901, matched: true, detectedNumber: 5.5 }],
      relatedSubjects: [], fallbackLocalization: { provider: 'old' } };
    const staleVolumes = { 901: { subjectId: 901, nameJa: '旧卷', nameCn: '旧卷译名', localizationVersion: 3,
      updatedAt: new Date().toISOString(), translatedSummary: '旧卷简介', volumeNumbers: [5.5] } };
    await metadata.writeSeriesBundle({ ...existing.series, bangumiSubjectId: 900 }, existing.resources,
      { bangumi: staleBangumi, volumeDetails: staleVolumes });
    await metadata.updateSeriesOverrides(oldId, { forcedSubjectId: 999 });
    await require('../lib/metadataCache').remember({ ...existing.series, title: parsed.title, authors: parsed.authors }, {
      series: { ...existing.series, seriesId: 'other-source' }, resources: existing.resources,
      bangumi: { ...staleBangumi, subjectId: 100, name: parsed.title, name_cn: parsed.title }, volumeDetails: staleVolumes,
    });
    const stages = { parse: 0, search: 0, choose: 0, volume: 0, summary: 0, names: 0, fetched: [] };
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('api.bgm.tv')) {
        stages.fetched.push(target);
        if (target.includes('/search/')) {
          stages.search++;
          return response({ data: [...Array.from({ length: 13 }, (_, i) => ({ ...candidate, id: 2000 + i })), candidate] });
        }
        assert(stages.choose > 0, 'subject details must only be fetched after AI has selected the main subject ID');
        assert(!/\/subjects\/20\d\d(?:\/|$)/.test(target), 'unselected candidates must not enter the detail pipeline');
        if (target.endsWith('/subjects/100/subjects')) return response([{ id: 101, name: 'あたらしい作品 (5.5)', name_cn: '', type: 1, relation: '单行本' }]);
        if (target.endsWith('/subjects/100/persons') || target.endsWith('/subjects/100/characters')) return response([]);
        const id = target.endsWith('/101') ? 101 : 100;
        return response({ id, type: 1, name: id === 101 ? 'あたらしい作品 (5.5)' : 'あたらしい作品', name_cn: '',
          infobox: { 作者: 'あたらしい著者' }, summary: 'あたらしい紹介です。', images: { large: 'https://example.test/new-cover.jpg' } });
      }
      const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      let result;
      if (payload.task === 'parse_resource_name') { stages.parse++; result = parsed; }
      else if (payload.task === 'suggest_bangumi_book_search_keywords') result = { keywords: [parsed.title] };
      else if (payload.task === 'choose_best_bangumi_book_subject') {
        stages.choose++; assert(!JSON.stringify(payload.local).includes('旧译名'));
        assert.equal(payload.candidates.length, 14, 'all deduplicated search results must reach AI');
        assert.equal(payload.candidates[13].subjectId, 100, 'AI must be able to select a result beyond the old 12-candidate limit');
        result = { matched: true, subjectId: 100, confidence: 95, reason: '重新识别' };
      } else if (payload.task === 'match_local_resources_to_bangumi_offprints') {
        stages.volume++; result = { results: payload.resources.map(resource => ({ resourceKey: resource.resourceKey,
          matched: true, subjectId: 101, confidence: 90, displayTitle: '第5.5册' })) };
      } else if (payload.entries) {
        stages.names++; result = { results: payload.entries.map(entry => ({ key: entry.key,
          nameCn: entry.kind === 'work' ? '全新中文作品名' : '全新作者译名' })) };
      } else if (payload.text) { stages.summary++; result = '重新翻译的简体中文简介'; }
      else throw new Error('unexpected force stage: ' + JSON.stringify(payload));
      return response({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] });
    };
    const fresh = await archive.scrapeSeries(oldId, { force: true });
    assert.equal(fresh.bangumi.subjectId, 100, 'force must ignore both retained and previously forced subject IDs');
    assert.equal(fresh.bangumi.name_cn, '全新中文作品名');
    assert.equal(fresh.bangumi.translatedSummary, '重新翻译的简体中文简介');
    assert.equal(fresh.bangumi.fallbackLocalization, undefined);
    assert.equal(fresh.bangumi.volumeMatches[0].subjectId, 101);
    assert.equal(fresh.bangumi.volumeMatches[0].displayTitle, '第5.5册', 'detail localization must not overwrite the AI display name');
    assert.equal(fresh.bangumi.volumeMatches[0].displayTitleSource, 'ai');
    assert.equal(fresh.volumeDetails[101].nameCn, '全新中文作品名 第5.5册', 'the full detail name is still localized independently');
    assert.equal(fresh.volumeDetails[101].displayTitle, '第5.5册');
    const cached = await require('../lib/metadataCache').find(fresh.series, fresh.resources, { subjectId: 100 });
    const [reused] = require('../lib/metadataCache').reusedVolumeMatches({
      resources: [{ ...fresh.resources[0], resourceId: 'another-source-volume', detectedNumber: 5.5, detectedNumberEnd: 5.5 }],
      volumeDetails: cached.data.volumeDetails,
    });
    assert.equal(reused.displayTitle, '第5.5册', 'shared metadata must preserve AI display names for new resource IDs');
    assert.equal(reused.displayTitleSource, 'ai');
    assert(!fresh.volumeDetails[901], 'old volume metadata must not survive a complete refresh');
    assert.equal(fresh.overrides.forcedSubjectId, undefined);
    assert(stages.parse && stages.search && stages.choose && stages.volume && stages.names && stages.summary >= 2, JSON.stringify(stages));
    assert(stages.fetched.some(url => url.endsWith('/subjects/101')), 'force must fetch volume details even when old details are cached');
    assert(!stages.fetched.some(url => /\/(900|901|999)$/.test(url)), 'old IDs must not be fetched');
    console.log('AI parsing/cache/identity, semantic verdicts, localized failure fallback and complete forced rescraping passed.');
  } finally { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
