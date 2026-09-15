const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings } = require('./settings-fixture');
const { researchFetch } = require('./localization-fixture');
const subject = require('./fixtures/bangumi-303952.json');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-localization-'));
  process.env.DATA_DIR = root;
  prepareSettings({ dataRoot: root, sources: [], aiWebSearchEnabled: true });
  const config = require('../lib/config');
  const settings = require('../lib/settingsStore');
  const setSearch = enabled => { const draft = settings.snapshot(); draft.metadata.aiWebSearchEnabled = enabled; return settings.save(draft); };
  const archive = require('../lib/archiveSource');
  const metadata = require('../lib/metadataStore');
  const cache = require('../lib/metadataCache');
  const { LOCALIZATION_VERSION, researchNames, translationContext } = require('../lib/metadataLocalization');
  const originalFetch = global.fetch;
  const originalKey = Object.getOwnPropertyDescriptor(config, 'AI_API_KEY');
  const originalModel = Object.getOwnPropertyDescriptor(config, 'AI_MODEL');
  const setKey = key => Object.defineProperty(config, 'AI_API_KEY', { configurable: true, value: key });
  Object.defineProperty(config, 'AI_MODEL', { configurable: true, value: 'test-model' });
  const old = { subjectId: subject.id, name: subject.name, titleSource: subject.name,
    name_cn: '背后的正面是神威小姐', titleLocalizationProvider: 'deepseek',
    titleLocalizedAt: '2026-09-01', detailsSchemaVersion: 2, infobox: subject.infobox };
  try {
    setKey('');
    global.fetch = async () => { throw new Error('Chinese names must not call any network or AI service'); };
    assert.equal((await archive.localizeBangumiTitle(subject, old)).title, '正后方的神威');
    assert.equal((await archive.localizeBangumiTitle({ ...subject, name_cn: '正後方的神威' }, old)).title, '正后方的神威');
    assert.equal((await archive.localizeBangumiTitle({ ...subject, name_cn: '' }, old)).title, '正后方的神威');
    assert.equal((await archive.localizeBangumiTitle({ name: 'かむい', infobox: '{{Infobox\n|中文名=正後方的神威\n}}' }, old)).title, '正后方的神威');
    assert.equal((await archive.localizeBangumiTitle({ name: 'かむい', infobox: { 中文名: '正後方的神威' } }, old)).title, '正后方的神威');
    assert.equal((await archive.localizeBangumiTitle({ name: '春原ロビンソン', infobox: [{ key: '简体中文名', value: '春原罗宾逊' }] })).title, '春原罗宾逊');
    assert.equal((await archive.localizeBangumiTitle({ name: 'かむい', infobox: { 繁體中文名: '正後方的神威' } })).title, '正后方的神威');
    const princessContext = { originalTitle: '姫様“拷問”の時間です', chineseTitle: '公主大人，接下来是“拷问”时间' };
    for (let number = 1; number <= 19; number++) {
      const volume = await archive.localizeBangumiTitle({ type: 1, name: princessContext.originalTitle + ' (' + number + ')' }, {}, princessContext);
      assert.equal(volume.title, princessContext.chineseTitle + ' 第' + number + '册');
      assert.equal(volume.provider, 'series_title');
    }
    for (const name of ['姫様“拷問”の時間です 画集 (1)', '姫様“拷問”の時間です 特装版 (1)', '姫様“拷問”の時間です 第2期']) {
      assert.notEqual((await archive.localizeBangumiTitle({ type: 1, name }, {}, princessContext)).provider, 'series_title', 'specific editions and adaptations are never replaced by a series title');
    }
    assert.notEqual((await archive.localizeBangumiTitle({ type: 2, name: princessContext.originalTitle + ' (1)' }, {}, princessContext)).provider, 'series_title');
    assert.notEqual((await archive.localizeBangumiTitle({ type: 1, name: princessContext.originalTitle + ' (1)' }, {}, { ...princessContext, chineseTitle: princessContext.originalTitle })).provider, 'series_title', 'an untranslated series name is not a verified Chinese title');
    assert.equal((await archive.localizeBangumiTitle({ ...old, infobox: {} }, old)).title, subject.name, 'legacy generated display names are not Chinese source evidence');
    assert.equal((await archive.maybeSimplifyChinese('summary', '繁體中文簡介')).text, '繁体中文简介');
    assert.equal((await archive.maybeSimplifyChinese('title', '正后方的神威')).translation, null);
    const volumeMatches = archive.parseDeepSeekVolumeMatchResponse(JSON.stringify({ results: [
      { resourceKey: 'kamui-volume', subjectId: 303953, confidence: 100, displayTitle: '背后的正面是神威小姐' },
    ] }), [{ resourceId: 'kamui-volume', title: '第1卷', detectedNumber: 1 }],
    [{ subjectId: 303953, name: subject.name, nameCn: '正后方的神威' }], { title: '其他系列' });
    assert.equal(volumeMatches[0].displayTitle, '背后的正面是神威小姐', 'AI card titles are kept independently from known detail names');
    assert.equal(volumeMatches[0].candidateNameCn, '正后方的神威');
    const people = await archive.localizeMetadataNames([{ personId: 1, name: 'カムイ', nameCn: '神威' }], [{ characterId: 2, name: '桜島麻衣', nameCn: '櫻島麻衣', actors: [{ personId: 3, name: '瀬戸麻沙美', nameCn: '瀨戶麻沙美' }] }]);
    assert.equal(people.persons[0].nameCn, '神威');
    assert.equal(people.characters[0].nameCn, '樱岛麻衣');
    assert.equal(people.characters[0].actors[0].nameCn, '濑户麻沙美');
    assert.equal(archive.inheritLocalizedMetadataNames([{ personId: 1, name: 'カムイ' }], [], {
      persons: [{ personId: 1, name: 'カムイ', nameCn: '神威小姐', nameTranslationProvider: 'deepseek' }],
    }).persons[0].nameCn, '');

    setKey('test-key');
    let researchCalls = 0;
    const fixture = researchFetch([{ sourceName: 'うしろの正面カムイさん', nameCn: '從後面來的神威先生' }], request => {
      researchCalls++;
      if (request.input) assert.ok(JSON.parse(request.input.at(-1).content).entries.length);
      else { assert.equal(request.tools, undefined); assert.ok(JSON.parse(request.messages.at(-1).content).entries.length); }
    });
    global.fetch = fixture;
    const researched = await archive.localizeBangumiTitle({ id: subject.id, name: subject.name, name_cn: '' }, {});
    assert.equal(researched.title, '从后面来的神威先生');
    assert.equal(researched.provider, 'ai_translation');
    assert.deepEqual(researched.sources, []);
    const saved = { subjectId: subject.id, name: subject.name, titleSource: subject.name,
      name_cn: researched.title, titleSources: researched.sources, titleLocalizationProvider: researched.provider,
      localizationVersion: LOCALIZATION_VERSION, titleLocalizedAt: researched.translatedAt };
    await archive.localizeBangumiTitle({ id: subject.id, name: subject.name }, saved);
    assert.equal(researchCalls, 1, 'verified names may be cached');
    assert.equal((await archive.localizeBangumiTitle(subject, saved)).title, '正后方的神威', 'a new Bangumi Chinese name overrides even verified AI cache');

    await setSearch(false);
    let disabledCalls = 0;
    const directFixture = researchFetch([
      { sourceName: subject.name, nameCn: '從後面來的神威先生' },
      { sourceName: '未確認著者', nameCn: '未确认作者' },
      { sourceName: '桜島麻衣', nameCn: '櫻島麻衣' },
      { sourceName: '瀬戸麻沙美', nameCn: '瀨戶麻沙美' },
    ]);
    global.fetch = async (url, options) => {
      disabledCalls++;
      assert.ok(new URL(url).pathname.endsWith('/chat/completions'), 'disabled search only uses ordinary AI translation');
      assert.equal(JSON.parse(options.body).tools, undefined);
      return directFixture(url, options);
    };
    const direct = (await researchNames([{ key: 'title', sourceName: subject.name }])).get('title');
    assert.equal(direct.provider, 'ai_translation'); assert.deepEqual(direct.sources, []);
    const directTitle = await archive.localizeBangumiTitle({ id: subject.id, name: subject.name });
    assert.equal(directTitle.title, '从后面来的神威先生'); assert.equal(directTitle.provider, 'ai_translation');
    const directSaved = { ...saved, name_cn: directTitle.title, titleLocalizationProvider: 'ai_translation', titleSources: [] };
    const beforeReuse = disabledCalls;
    assert.equal((await archive.localizeBangumiTitle({ id: subject.id, name: subject.name }, directSaved)).provider, 'ai_translation');
    assert.equal(disabledCalls, beforeReuse, 'direct translations can be reused while search remains off');
    assert.equal((await archive.localizeBangumiTitle({ id: subject.id, name: subject.name }, saved)).title, saved.name_cn, 'verified persisted names remain available');
    assert.equal((await archive.localizeBangumiTitle(subject)).title, '正后方的神威');
    const translated = await archive.localizeMetadataNames([{ personId: 999, name: '未確認著者' }], [{ characterId: 1, name: '桜島麻衣', actors: [{ personId: 3, name: '瀬戸麻沙美' }] }]);
    assert.equal(translated.persons[0].nameCn, '未确认作者');
    assert.equal(translated.characters[0].nameCn, '樱岛麻衣');
    assert.equal(translated.characters[0].actors[0].nameCn, '濑户麻沙美');
    for (const item of [translated.persons[0], translated.characters[0], translated.characters[0].actors[0]]) {
      assert.equal(item.nameTranslationProvider, 'ai_translation'); assert.deepEqual(item.nameSources, []);
    }
    assert.equal(archive.inheritLocalizedMetadataNames([{ personId: 999, name: '未確認著者' }], [], translated).persons[0].nameCn, '未确认作者');

    // Keep model-provided names, including the separator that previously rejected BASEBOY's manager.
    const modelNames = [
      { sourceName: 'BASEBOY 店長・安藤', nameCn: 'BASEBOY 店长・安藤' },
      { sourceName: 'BASEBOY バイト店員', nameCn: 'BASEBOY' },
      { sourceName: '佐古レイラ', nameCn: '佐古レイラ' },
    ];
    global.fetch = researchFetch(modelNames);
    const acceptedNames = await archive.localizeMetadataNames([], modelNames.map((item, index) => ({ characterId: index + 1, name: item.sourceName })));
    assert.deepEqual(acceptedNames.characters.map(item => item.nameCn), modelNames.map(item => item.nameCn));
    const acceptedContext = translationContext({}, [], acceptedNames.characters);
    assert.equal(acceptedContext.terms.length, modelNames.length, 'accepted model names remain available to later translations');
    global.fetch = async () => { throw new Error('Accepted names must be reused from context'); };
    const reusedNames = await archive.localizeMetadataNames(modelNames.map((item, index) => ({ personId: index + 1, name: item.sourceName })), [], {}, acceptedContext);
    assert.deepEqual(reusedNames.persons.map(item => item.nameCn), modelNames.map(item => item.nameCn));
    global.fetch = directFixture;

    assert.equal((await archive.maybeTranslate('summary', 'これは未翻訳のあらすじです。')).translatedText, '这是中文译文');
    assert.ok(disabledCalls > 0, 'disabling web search does not disable AI translation');
    await setSearch(true);
    global.fetch = fixture;
    assert.equal((await archive.localizeBangumiTitle({ id: subject.id, name: subject.name }, directSaved)).provider, 'ai_translation', 'mode changes preserve translations');
    assert.equal(archive.inheritLocalizedMetadataNames([{ personId: 999, name: '未確認著者' }], [], translated).persons[0].nameCn, '未确认作者', 'name translations remain stable when book search is enabled');
    global.fetch = researchFetch([{ sourceName: subject.name, nameCn: researched.title }]);
    assert.equal((await researchNames([{ key: 'title', sourceName: subject.name }])).get('title').nameCn, researched.title);

    let personRequests = 0;
    global.fetch = async (url, options) => {
      assert.ok(new URL(url).pathname.endsWith('/chat/completions'), 'people and non-book titles never search, even while enabled');
      const request = JSON.parse(options.body);
      assert.equal(request.tools, undefined);
      const input = JSON.parse(request.messages.at(-1).content);
      if (input.entries) {
        personRequests++;
        assert.equal(new Set(input.entries.map(entry => entry.sourceName)).size, input.entries.length, 'one source name is translated once across roles');
        return directFixture(url, options);
      }
      assert.ok(input.context.terms.some(term => term.sourceName === '桜島麻衣' && term.nameCn === '樱岛麻衣'));
      assert.ok(input.context.terms.some(term => term.sourceName === '瀬戸麻沙美' && term.nameCn === '濑户麻沙美'));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '樱岛麻衣与濑户麻沙美。' } }] }) };
    };
    const peopleWhileEnabled = await archive.localizeMetadataNames([
      { personId: 10, name: '桜島麻衣' }, { personId: 'author-duplicate', name: '桜島麻衣' },
    ], [{ characterId: 10, name: '桜島麻衣', actors: [{ personId: 11, name: '瀬戸麻沙美' }] }]);
    assert.equal(personRequests, 1);
    assert.ok(peopleWhileEnabled.persons.every(person => person.nameCn === '樱岛麻衣' && person.nameTranslationProvider === 'ai_translation'));
    const sharedKnownName = await archive.localizeMetadataNames([{ personId: 10, name: '桜島麻衣', nameCn: '樱岛麻衣' }], [{ characterId: 10, name: '桜島麻衣' }]);
    assert.equal(sharedKnownName.characters[0].nameCn, '樱岛麻衣');
    assert.equal(personRequests, 1, 'a known name in another role is reused without another model request');
    const glossary = translationContext(subject, peopleWhileEnabled.persons, peopleWhileEnabled.characters);
    assert.equal(glossary.terms.filter(term => term.sourceName === '桜島麻衣').length, 1);
    assert.equal(translationContext({}, [{ name: '未翻訳の名前', nameCn: '' }]).terms.length, 0, 'an untranslated original is not a confirmed glossary entry');
    assert.equal((await archive.maybeTranslate('summary', '桜島麻衣と瀬戸麻沙美。', glossary)).translatedText, '樱岛麻衣与濑户麻沙美。');
    for (const type of [2, 4]) {
      assert.equal((await archive.localizeBangumiTitle({ type, name: subject.name })).provider, 'ai_translation');
    }
    const beforeRelated = personRequests;
    const directRelated = await archive.localizeBangumiTitle({ id: subject.id, type: 1, name: subject.name }, {}, {}, { allowWebSearch: false });
    assert.equal(directRelated.provider, 'ai_translation');
    assert.deepEqual(directRelated.sources, []);
    assert.equal(personRequests, beforeRelated + 1, 'related books use ordinary translation while web search is enabled');
    assert.equal((await archive.localizeBangumiTitle({ id: subject.id, type: 1, name: subject.name }, directSaved, {}, { allowWebSearch: false })).provider, 'ai_translation');
    assert.equal(personRequests, beforeRelated + 1, 'direct related-title caches do not get upgraded to web research');

    // Fabricated citations and unsupported names must not become verified metadata.
    const verifiedSource = { url: 'https://www.wikidata.org/wiki/Q1', excerpt: '從後面來的神威先生' };
    for (const [row, reason] of [
      [{ nameCn: '从后面来的神威先生', confidence: 95, sources: [{ ...verifiedSource, url: 'https://fabricated.example/name' }] }, '引用链接不在本次搜索工具返回的来源中'],
      [{ nameCn: '背后的正面是神威小姐', confidence: 95, sources: [verifiedSource] }, '引用摘录未包含完整译名'],
      [{ nameCn: '从后面来的神威先生', confidence: 20, sources: [verifiedSource] }, '模型置信度低于 80'],
      [{ nameCn: '从后面来的神威先生', confidence: 95, sources: 'https://www.wikidata.org/wiki/Q1' }, '引用链接不在本次搜索工具返回的来源中'],
      [{ nameCn: 'Jump+ Jumble Rush', confidence: 99, sources: [verifiedSource] }, '模型未提供中文译名'],
    ]) {
      global.fetch = async (url, options) => {
        const response = await fixture(url, options);
        const data = await response.json();
        data.output[1].content[0].text = JSON.stringify({ results: [{ key: 'title', ...row }] });
        return { ok: true, json: async () => data };
      };
      const warnings = [], originalWarn = console.warn;
      console.warn = message => warnings.push(message);
      try { assert.equal((await researchNames([{ key: 'title', sourceName: subject.name }])).size, 0); }
      finally { console.warn = originalWarn; }
      assert.ok(warnings.some(message => message.includes(subject.name) && message.includes(reason)), 'rejected names explain their exact cause');
    }
    let modelCalls = 0;
    global.fetch = researchFetch([], () => { modelCalls++; });
    assert.equal((await archive.localizeBangumiTitle({ name: '存在しない検証書名' })).title, '存在しない検証書名');
    assert.equal(modelCalls, 1, 'a single native search returns no speculative translation');
    global.fetch = async () => { throw new Error('offline fixture'); };
    assert.equal((await researchNames([{ key: 'title', sourceName: '別の未検証書名' }])).size, 0);

    // Exercise the real Responses parser and retries through to the translation fallback.
    const logs = [], originalLog = console.log, originalWarn = console.warn;
    console.log = console.warn = message => logs.push(message);
    try {
      for (const succeedOn of [2, 3, 4]) {
        logs.length = 0;
        let attempts = 0;
        const endpoints = [];
        global.fetch = async (url, options) => {
          const endpoint = new URL(url).pathname;
          endpoints.push(endpoint);
          if (endpoint.endsWith('/responses')) {
            attempts++;
            if (attempts >= succeedOn) return fixture(url, options);
            return new Response('data: ' + JSON.stringify({ type: 'response.incomplete', response: {
              id: 'resp_retry', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
              error: { code: 'upstream_error', message: 'try again test-key' },
            } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
          }
          assert.ok(endpoint.endsWith('/chat/completions'));
          assert.equal(JSON.parse(options.body).tools, undefined);
          return directFixture(url, options);
        };
        const names = await researchNames([{ key: 'title', sourceName: subject.name }], { subjectId: subject.id });
        assert.equal(attempts, Math.min(succeedOn, 3), 'at most three attempts, stopping as soon as search succeeds');
        assert.deepEqual(endpoints, [...Array(attempts).fill('/v1/responses'), ...(succeedOn > 3 ? ['/v1/chat/completions'] : [])]);
        assert.equal(names.get('title').nameCn, researched.title);
        assert.equal(names.get('title').provider, succeedOn > 3 ? 'ai_translation' : 'ai_web_research');
        if (succeedOn > 3) {
          assert.deepEqual(names.get('title').sources, []);
          assert.ok(logs.some(line => line.includes('连续 3 次失败，回退直接翻译')));
          assert.ok(logs.some(line => line.includes('回退结果') && line.includes('"translated":1')));
        } else assert.ok(!logs.some(line => line.includes('回退')));
        assert.ok(logs.some(line => line.includes('失败 1/3') && line.includes('max_output_tokens') && line.includes('"retryDelayMs":1000')));
        assert.ok(logs.some(line => line.includes('subjectId') && line.includes(String(subject.id)) && line.includes(subject.name)));
        assert.ok(!logs.some(line => line.includes('test-key')));
      }

      // Invalid result JSON retries; partial direct translations keep originals and explain the remainder.
      logs.length = 0;
      let invalidAttempts = 0, translations = 0;
      global.fetch = async (url, options) => {
        if (new URL(url).pathname.endsWith('/responses')) {
          invalidAttempts++;
          const data = await (await fixture(url, options)).json();
          data.output[1].content[0].text = invalidAttempts === 1 ? 'invalid JSON' : '{}';
          return { ok: true, json: async () => data };
        }
        translations++;
        return directFixture(url, options);
      };
      const partial = await researchNames([{ key: 'title', sourceName: subject.name }, { key: 'missing', sourceName: '未翻訳書名' }]);
      assert.equal(invalidAttempts, 3); assert.equal(translations, 1);
      assert.equal(partial.size, 1); assert.equal(partial.get('title').provider, 'ai_translation');
      assert.ok(logs.some(line => line.includes('不是有效 JSON')));
      assert.ok(logs.some(line => line.includes('缺少 results 数组')));
      assert.ok(logs.some(line => line.includes('retainedOriginals') && line.includes('未翻訳書名')));

      // A live settings change prevents any further search attempts.
      let disabledAttempts = 0;
      global.fetch = async (url, options) => {
        if (new URL(url).pathname.endsWith('/responses')) {
          disabledAttempts++;
          await setSearch(false);
          throw new Error('search disabled during failure');
        }
        return directFixture(url, options);
      };
      assert.equal((await researchNames([{ key: 'title', sourceName: subject.name }])).get('title').provider, 'ai_translation');
      assert.equal(disabledAttempts, 1);
    } finally {
      console.log = originalLog; console.warn = originalWarn;
      await setSearch(true);
    }

    // Exercise the persisted scraper, old shared cache, API infobox people, and summary ordering.
    const series = { seriesId: 'kamui', title: old.name_cn, category: 'comic', authors: [] };
    await metadata.writeSeriesBundle(series, [], { bangumi: old });
    await metadata.rebuildIndexes([series], []);
    await cache.remember(series, { series, resources: [], bangumi: old });
    const japaneseSummary = 'カムイと志津香が幽霊を見る物語です。';
    const events = [];
    const relatedTitles = [
      { id: 9001, type: 1, relation: '续集', name: '神威さんの続き', nameCn: '神威的续篇' },
      { id: 9002, relation: '番外篇', name: '神威さんの外伝', nameCn: '神威外传' },
      { id: 9003, type: 1, relation: '其他', name: '神威さんのイラスト集', nameCn: '神威画集' },
      { id: 9004, type: 1, relation: '单行本', name: '神威さんの特別な一日', nameCn: '神威特别的一天' },
    ];
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const json = data => ({ ok: true, json: async () => data });
      if (parsed.hostname === 'api.bgm.tv') {
        events.push(parsed.pathname);
        if (parsed.pathname === '/v0/subjects/303952') return json({ ...subject, summary: japaneseSummary, infobox: [{ key: '中文名', value: subject.name_cn }] });
        if (parsed.pathname.endsWith('/persons')) return json([]);
        if (parsed.pathname.endsWith('/characters')) return json([{ id: 1, name: '志津香', images: { large: 'https://example.test/image.jpg' } }, { id: 2, name: 'カムイ' }]);
        if (parsed.pathname === '/v0/characters/1') return json({ id: 1, name: '志津香', infobox: [{ key: '中文名', value: '耳塚志津香' }] });
        if (parsed.pathname === '/v0/characters/2') return json({ id: 2, name: 'カムイ', infobox: [] });
        if (parsed.pathname === '/v0/subjects/303952/subjects') return json(relatedTitles.map(({ nameCn, ...item }) => ({ ...item, images: { large: 'https://example.test/related.jpg' } })));
        if (parsed.pathname.endsWith('/subjects')) return json([]);
        throw new Error('Unexpected Bangumi request ' + parsed.pathname);
      }
      const request = JSON.parse(options.body);
      events.push('ai:' + parsed.pathname);
      assert.ok(parsed.pathname.endsWith('/chat/completions'), 'this known book needs no search for its people or summary');
      const payload = JSON.parse(request.messages.at(-1).content);
      if (payload.entries) {
        assert.equal(payload.entries.length, 1);
        const related = relatedTitles.find(item => item.name === payload.entries[0].sourceName);
        if (related) {
          assert.equal(payload.context.chineseTitle, '正后方的神威');
          return json({ choices: [{ message: { content: JSON.stringify({ results: [{ key: payload.entries[0].key, nameCn: related.nameCn }] }) } }] });
        }
        assert.equal(payload.entries[0].sourceName, 'カムイ');
        assert.ok(payload.context.terms.some(term => term.sourceName === '志津香' && term.nameCn === '耳冢志津香'));
        events.push('translate-names');
        return json({ choices: [{ message: { content: JSON.stringify({ results: [{ key: payload.entries[0].key, nameCn: '神威' }] }) } }] });
      }
      assert.equal(payload.text, japaneseSummary);
      assert.equal(payload.context.chineseTitle, '正后方的神威');
      assert.ok(payload.context.terms.some(term => term.sourceName === '志津香' && term.nameCn === '耳冢志津香'));
      assert.ok(payload.context.terms.some(term => term.sourceName === 'カムイ' && term.nameCn === '神威'));
      assert.ok(events.includes('translate-names'), 'direct name translation must finish before the summary');
      assert.ok(events.includes('/v0/characters/1'), 'person source names must be fetched before summary translation, even with images');
      events.push('summary');
      return json({ choices: [{ message: { content: '《正后方的神威》中，神威與耳塚志津香一同除靈。' } }] });
    };
    await setSearch(false); // This integration assertion exercises the retained traditional pipeline.
    const retained = await archive.scrapeSeries('kamui');
    assert.equal(retained.bangumi.name_cn, old.name_cn, 'existing results are not implicitly upgraded');
    assert.deepEqual(events, []);
    const updated = await archive.scrapeSeries('kamui', { force: true, subjectId: subject.id });
    assert.equal(updated.series.title, '正后方的神威');
    assert.equal(updated.bangumi.bangumiNameCn, '正后方的神威');
    assert.equal(updated.bangumi.titleLocalizationProvider, 'bangumi');
    assert.equal(updated.bangumi.localizationVersion, LOCALIZATION_VERSION);
    assert.ok(!events.some(event => event.includes('/responses')), 'the full scrape never searches for related entries, including offprints and books without type data');
    for (const related of relatedTitles) {
      const stored = updated.bangumi.relatedSubjects.find(item => item.subjectId === related.id);
      assert.equal(stored.name_cn, related.nameCn);
      assert.equal(stored.titleLocalizationProvider, 'ai_translation');
      assert.deepEqual(stored.titleSources, []);
    }
    assert.equal(updated.bangumi.translatedSummary, '《正后方的神威》中，神威与耳冢志津香一同除灵。');
    assert.equal(events.filter(event => event === 'summary').length, 1);
    assert.equal(updated.bangumi.isManualOverride, true);
    const { createLocalMetadataService, descriptorKey } = require('../lib/localMetadata');
    const directory = path.join(root, 'old-device-jobs');
    await fs.mkdir(directory);
    const descriptor = { title: subject.name_cn, author: '', originalName: '神威.cbz', mediaType: 'comic' };
    const oldJobId = '00000000-0000-4000-8000-000000000001';
    await fs.writeFile(path.join(directory, oldJobId + '.json'), JSON.stringify({ id: oldJobId,
      ownerId: 'test', descriptor, key: descriptorKey(descriptor), status: 'success',
      metadata: { title: old.name_cn, localizationVersion: 0 } }));
    const service = createLocalMetadataService({ directory, runAsUser: (_, work) => work(),
      resolve: async () => ({ title: subject.name_cn, localizationVersion: LOCALIZATION_VERSION }) });
    await service.initialize();
    const job = await service.submit('test', descriptor);
    assert.equal(job.id, oldJobId, 'legacy completed device results remain protected');
    for (let i = 0; i < 100 && service.get('test', job.id).status !== 'success'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.get('test', job.id).metadata.title, old.name_cn);
    assert.equal((await service.submit('test', descriptor)).id, job.id, 'current completed jobs are still reused');
    const previousConcurrency = Object.getOwnPropertyDescriptor(config, 'AI_MAX_CONCURRENCY');
    Object.defineProperty(config, 'AI_MAX_CONCURRENCY', { configurable: true, value: 1 });
    try {
      let release, started, dispatched = 0;
      const gate = new Promise(resolve => { release = resolve; });
      const firstBatch = new Promise(resolve => { started = resolve; });
      const queuedFixture = researchFetch([{ sourceName: subject.name, nameCn: '從後面來的神威先生' }]);
      global.fetch = async (url, options) => {
        if (new URL(url).pathname.endsWith('/responses')) { dispatched++; started(); await gate; }
        return queuedFixture(url, options);
      };
      const entries = Array.from({ length: 9 }, (_, i) => ({ key: 'queued-' + i, sourceName: subject.name }));
      const queued = researchNames(entries);
      await firstBatch;
      await setSearch(false);
      release();
      const queuedNames = await queued;
      assert.equal(queuedNames.size, 9);
      assert.ok([...queuedNames.values()].every(item => item.provider === 'ai_translation'));
      assert.equal(dispatched, 1, 'saving off stops queued searches and continues with direct translation');
      await setSearch(true);
      global.fetch = fixture;
      assert.equal((await researchNames(entries)).size, 9, 're-enabling retries skipped research immediately');
    } finally { Object.defineProperty(config, 'AI_MAX_CONCURRENCY', previousConcurrency); }
    console.log('Metadata localization: source evidence, failure fallback, cached names, summary ordering and live web-search toggle passed.');
  } finally {
    global.fetch = originalFetch;
    Object.defineProperty(config, 'AI_API_KEY', originalKey);
    Object.defineProperty(config, 'AI_MODEL', originalModel);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
