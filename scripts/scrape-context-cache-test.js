const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareSettings } = require('./settings-fixture');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for fixture task');
}
const descriptor = (title = '原始作品') => ({ title, author: '作者', originalName: title + ' Vol.01.epub', mediaType: 'novel' });

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-context-cache-'));
  process.env.DATA_DIR = root;
  prepareSettings({ dataRoot: root, sources: [] });
  const store = require('../lib/settingsStore');
  const context = require('../lib/scrapeContext');
  const config = require('../lib/config');
  const cache = require('../lib/metadataCache');
  const ai = require('../lib/aiProvider');
  const { createLocalMetadataService, descriptorKey } = require('../lib/localMetadata');
  const { LOCALIZATION_VERSION } = require('../lib/metadataLocalization');
  const original = { snapshot: store.snapshot, secrets: store.secrets, fetch: global.fetch };
  let live = store.snapshot();
  let credentials = { aiApiKey: 'fixture-secret-a', bangumiToken: 'fixture-bangumi-a' };
  store.snapshot = () => structuredClone(live);
  store.secrets = () => structuredClone(credentials);
  const configure = (web, suffix) => {
    Object.assign(live.metadata, { aiWebSearchEnabled: web, aiBaseUrl: 'https://fixture.invalid/' + suffix,
      aiModel: 'fixture-' + suffix, aiReasoningEffort: suffix === 'a' ? 'high' : 'low', aiConcurrency: 1,
      matchEnabled: web, volumeMatchEnabled: web, localGroupEnabled: !web });
    credentials = { aiApiKey: 'fixture-secret-' + suffix, bangumiToken: 'fixture-bangumi-' + suffix };
  };
  try {
    configure(true, 'a');
    const first = context.captureContext();
    await context.runWithScrapeContext(first, async () => {
      configure(false, 'b');
      live.metadata.aiConcurrency = 2;
      await Promise.resolve();
      assert.equal(config.AI_WEB_SEARCH_ENABLED, true);
      assert.equal(config.AI_MODEL, 'fixture-a');
      assert.equal(config.AI_API_KEY, 'fixture-secret-a');
      assert.equal(config.BANGUMI_ACCESS_TOKEN, 'fixture-bangumi-a');
      assert.equal(config.AI_BASE_URL, 'https://fixture.invalid/a');
      assert.equal(config.AI_REASONING_EFFORT, 'high');
      assert.equal(config.DEEPSEEK_MATCH_ENABLED, true);
      assert.equal(config.DEEPSEEK_VOLUME_MATCH_ENABLED, true);
      assert.equal(config.DEEPSEEK_LOCAL_GROUP_ENABLED, false);
      assert.equal(config.AI_MAX_CONCURRENCY, 2, 'global scheduling limits remain live');
      assert.equal(context.withScrapeContext(() => context.currentContext()), first);
      const next = context.captureContext();
      assert.equal(next.mode, 'traditional', 'explicit capture reads current settings even inside an old task');
      context.withScrapeContext(next, () => assert.equal(config.DEEPSEEK_API_KEY, 'fixture-secret-b'));
      assert.equal(context.currentContext(), first);
    });
    assert.equal(context.currentContext(), null);
    assert.equal(config.AI_MODEL, 'fixture-b');
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(first))).sort(), ['mode', 'policyVersion', 'startedAt']);
    assert.throws(() => context.withScrapeContext(JSON.parse(JSON.stringify(first)), () => {}), /持久化/);

    // Provider work queued behind another context must carry its own snapshot.
    const calls = [];
    global.fetch = async (url, options) => {
      const gate = deferred(), body = JSON.parse(options.body);
      calls.push({ url, authorization: options.headers.Authorization, body, mode: context.currentContext()?.mode,
        model: config.AI_MODEL, gate });
      await gate.promise;
      return new Response(JSON.stringify(url.endsWith('/responses') ? { id: 'response-context', status: 'completed', output: [
        { id: 'search-context', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://bgm.tv/subject/1' }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'searched' }] },
      ] } : { choices: [{ message: { content: 'completed' } }] }));
    };
    configure(true, 'a');
    const active = ai.complete({ messages: [{ role: 'user', content: 'blocker' }] });
    await until(() => calls.length === 1);
    const queuedWeb = context.withScrapeContext(() => ai.webSearch({ messages: [{ role: 'user', content: 'web' }] }));
    configure(false, 'b');
    const queuedChat = context.withScrapeContext(() => ai.complete({ messages: [{ role: 'user', content: 'chat' }] }));
    calls[0].gate.resolve(); await active;
    await until(() => calls.length === 2);
    assert.equal(calls[1].mode, 'web'); assert.equal(calls[1].model, 'fixture-a');
    assert.equal(calls[1].authorization, 'Bearer fixture-secret-a');
    assert.equal(calls[1].body.model, 'fixture-a');
    calls[1].gate.resolve(); await queuedWeb;
    await until(() => calls.length === 3);
    assert.equal(calls[2].mode, 'traditional'); assert.equal(calls[2].model, 'fixture-b');
    calls[2].gate.resolve(); await queuedChat;
    assert.equal((await ai.webSearch({ messages: [] })).searchCalls, 0);
    assert.equal(calls.length, 3, 'disabled mode makes no network request');
    live.metadata.aiConcurrency = 2;
    const retryOptions = { baseUrl: config.AI_BASE_URL, apiKey: config.AI_API_KEY, model: config.AI_MODEL, concurrency: 1 };
    const nextPair = context.withScrapeContext(() => Promise.all(['retry-1', 'retry-2'].map(content =>
      ai.complete({ messages: [{ role: 'user', content }] }, retryOptions))));
    await until(() => calls.length === 5);
    calls[3].gate.resolve(); calls[4].gate.resolve(); await nextPair;
    assert.equal(calls.length, 5, 'stale per-task retry concurrency cannot undo the current global limit');

    // Web cache identity includes exact resource IDs and has no Bangumi dependency.
    const input = { localWork: { mediaType: 'novel', title: '同名作品', authors: ['作者一'] }, resources: [{ resourceId: 'r1', originalName: '01.epub' }] };
    const fingerprint = cache.inputFingerprint(input);
    assert.equal(fingerprint, cache.inputFingerprint({ resources: input.resources, localWork: { authors: ['作者一'], title: '同名作品', mediaType: 'novel' } }));
    const data = { work: { bangumiId: null, metadataKey: 'web:publisher:work', title: '中文作品' }, resources: [{ resourceId: 'r1', detailKey: 'web:publisher:volume-1' }] };
    await cache.rememberWeb(fingerprint, data);
    data.work.title = 'changed after save';
    assert.equal((await cache.findWeb(fingerprint)).data.work.title, '中文作品');
    const read = await cache.findWeb(fingerprint); read.data.work.title = 'changed after read';
    assert.equal((await cache.findWeb(fingerprint)).data.work.title, '中文作品');
    assert.equal(await cache.findWeb(fingerprint, { force: true }), null);
    assert.equal(await cache.findWeb(fingerprint, { policyVersion: context.WEB_SCRAPE_POLICY_VERSION + 1 }), null);
    for (const changed of [
      { ...input, resources: [{ resourceId: 'r2', originalName: '01.epub' }] },
      { ...input, localWork: { ...input.localWork, authors: ['作者二'] } },
      { ...input, localWork: { ...input.localWork, mediaType: 'comic' } },
      { ...input, resources: [{ resourceId: 'r1', originalName: '01 特装版.epub' }] },
    ]) assert.equal(await cache.findWeb(cache.inputFingerprint(changed)), null);
    assert.equal(await cache.find({ title: '同名作品', category: 'novel' }), null);
    const traditionalInput = { title: '传统作品', category: 'novel', sourcePath: '/private/not-cache-input', readingProgress: 42 };
    const traditional = await cache.remember(traditionalInput, { bangumi: { subjectId: 12, name: '传统作品' } });
    assert.equal(traditional.mode, 'traditional');
    assert.equal(traditional.policyVersion, context.TRADITIONAL_SCRAPE_POLICY_VERSION);
    assert.equal(traditional.inputFingerprint, cache.inputFingerprint(cache.identity({ title: '传统作品', category: 'novel' })));
    assert.ok(!JSON.stringify(traditional).includes('/private/not-cache-input'));
    const traditionalIndex = JSON.parse(await fs.readFile(path.join(config.METADATA_DIR, 'shared-scrapes/index.json'), 'utf8'));
    assert.equal(traditionalIndex['novel:12'].inputFingerprint, traditional.inputFingerprint);
    assert.equal(traditionalIndex['novel:12'].mode, 'traditional');
    assert.equal(traditionalIndex['novel:12'].policyVersion, context.TRADITIONAL_SCRAPE_POLICY_VERSION);
    assert.equal((await cache.find({ title: '传统作品', category: 'novel' })).subjectId, 12);
    assert.equal((await cache.find({ title: '传统作品 [高清]', category: 'novel' })).subjectId, 12, 'traditional matching remains compatible with normalized variants');
    const traditionalFile = path.join(config.METADATA_DIR, 'shared-scrapes', crypto.createHash('sha256').update('novel:12').digest('hex') + '.json');
    const untagged = structuredClone(traditional);
    for (const key of ['mode', 'policyVersion', 'inputFingerprint']) delete untagged[key];
    await fs.writeFile(traditionalFile, JSON.stringify(untagged));
    assert.equal((await cache.find({ title: '传统作品', category: 'novel' })).subjectId, 12, 'legacy records without metadata labels remain readable');
    for (const mode of ['web', 'unknown', null]) {
      await fs.writeFile(traditionalFile, JSON.stringify({ ...traditional, mode }));
      assert.equal(await cache.find({ title: '传统作品', category: 'novel' }), null, 'explicit incompatible modes are rejected');
    }
    await fs.writeFile(traditionalFile, JSON.stringify({ ...traditional, mode: 'web', data: { ...traditional.data,
      volumeDetails: { bad: { subjectId: 999, nameCn: '不可继承的异模式数据' } } } }));
    const refreshed = await cache.remember(traditionalInput, { bangumi: { subjectId: 12, name: '传统作品' } });
    assert.deepEqual(refreshed.data.volumeDetails, {}, 'remember does not merge volumes from an incompatible previous record');
    assert.equal(await cache.remember({ title: '联网作品', category: 'novel' }, {
      bangumi: { subjectId: 13, name: '联网作品', webScrape: { mode: 'web', policyVersion: 1 } },
    }), null, 'web results cannot be written into the traditional index');
    assert.equal(await cache.find({ title: '联网作品', category: 'novel' }), null);
    await cache.remember({ title: '受污染缓存', category: 'novel' }, { bangumi: { subjectId: 14, name: '受污染缓存' } });
    const contaminatedFile = path.join(config.METADATA_DIR, 'shared-scrapes', crypto.createHash('sha256').update('novel:14').digest('hex') + '.json');
    const contaminated = JSON.parse(await fs.readFile(contaminatedFile, 'utf8'));
    contaminated.data.bangumi.webScrape = { mode: 'web', policyVersion: 1 };
    await fs.writeFile(contaminatedFile, JSON.stringify(contaminated));
    assert.equal(await cache.find({ title: '受污染缓存', category: 'novel' }), null, 'previously indexed web data is rejected on read');
    await assert.rejects(cache.findWeb('../bad'), /SHA-256/);
    await assert.rejects(cache.findWeb(fingerprint, { policyVersion: '../bad' }), /版本/);

    // Device jobs persist only policy/fingerprint labels; queued jobs snapshot on start.
    configure(false, 'b');
    const directory = path.join(root, 'jobs'), started = [];
    const service = createLocalMetadataService({ directory, runAsUser: (_, operation) => operation(), resolve: async value => {
      const gate = deferred(), entry = { title: value.title, gate, mode: context.currentContext().mode,
        model: config.AI_MODEL, key: config.AI_API_KEY };
      started.push(entry);
      if (value.title.startsWith('block-')) await gate.promise;
      if (value.title === 'translation-error') throw new Error('翻译失败 ' + config.AI_API_KEY + ' ' + config.BANGUMI_ACCESS_TOKEN);
      await Promise.resolve();
      assert.equal(config.AI_MODEL, entry.model); assert.equal(config.AI_API_KEY, entry.key);
      return { localizationVersion: LOCALIZATION_VERSION, title: value.title, subjectId: null, metadataKey: 'local:' + value.title,
        fallback: value.title === 'fallback', fallbackReason: value.title === 'fallback' ? '未确认作品' : '',
        ...(value.title === 'partial' ? { scrapeStatus: 'partial', resourceFallback: true, fallbackReason: '主作品已确认，卷册仅中文化' } : {}) };
    } });
    await service.initialize();
    const blockers = await Promise.all(['block-1', 'block-2'].map(title => service.submit('owner', descriptor(title))));
    await until(() => started.length === 2);
    const queued = await service.submit('owner', descriptor('queued'));
    assert.equal(queued.status, 'queued'); assert.equal(queued.scrapeMode, 'traditional');
    configure(true, 'a');
    started[0].gate.resolve(); started[1].gate.resolve();
    await until(() => service.get('owner', queued.id)?.status === 'success');
    assert.equal(started[2].mode, 'web'); assert.equal(started[2].model, 'fixture-a');
    assert.equal(service.get('owner', queued.id).scrapeMode, 'web');
    for (const blocker of blockers) assert.equal(service.get('owner', blocker.id).scrapeMode, 'traditional');
    const duplicates = await Promise.all(Array.from({ length: 12 }, () => service.submit('owner', descriptor('queued'))));
    assert.ok(duplicates.every(job => job.id === queued.id));
    assert.equal(started.filter(entry => entry.title === 'queued').length, 1);
    configure(false, 'b');
    const switched = await service.submit('owner', descriptor('queued'));
    assert.equal(switched.id, queued.id, 'completed descriptions are reused across modes');
    await until(() => service.get('owner', switched.id)?.status === 'success');
    assert.equal(service.get('owner', queued.id).scrapeMode, 'web', 'old results remain available');
    configure(true, 'a');
    const fallback = await service.submit('owner', descriptor('fallback'));
    await until(() => service.get('owner', fallback.id)?.status === 'success');
    assert.equal(service.get('owner', fallback.id).scrapeCompletion, 'fallback');
    assert.equal(service.get('owner', fallback.id).scrapeReason, '未确认作品');
    assert.equal((await service.submit('owner', descriptor('fallback'))).id, fallback.id);
    const partial = await service.submit('owner', descriptor('partial'));
    await until(() => service.get('owner', partial.id)?.status === 'success');
    assert.equal(service.get('owner', partial.id).scrapeCompletion, 'partial');
    assert.equal(service.get('owner', partial.id).scrapeReason, '主作品已确认，卷册仅中文化');
    assert.equal(service.get('owner', partial.id).metadata.fallback, false);
    assert.equal(service.get('owner', partial.id).metadata.resourceFallback, true);
    assert.equal((await service.submit('owner', descriptor('partial'))).id, partial.id, 'partial results are complete and reusable');
    const rawVariant = await service.submit('owner', { ...descriptor('fallback'), title: 'fallback [高清]' });
    assert.notEqual(rawVariant.id, fallback.id, 'raw title changes must not use normalized-title completion reuse');
    await until(() => service.get('owner', rawVariant.id)?.status === 'success');
    const failed = await service.submit('owner', descriptor('translation-error'));
    await until(() => service.get('owner', failed.id)?.status === 'failed');
    assert.equal(service.get('owner', queued.id).metadata.title, 'queued');
    assert.equal(service.get('other-owner', queued.id), null);

    configure(false, 'b');
    const startOffset = started.length;
    await Promise.all(['block-coalesce-1', 'block-coalesce-2'].map(title => service.submit('owner', descriptor(title))));
    await until(() => started.length === startOffset + 2);
    const oldQueuedMode = await service.submit('owner', descriptor('coalesced'));
    configure(true, 'a');
    const newQueuedMode = await service.submit('owner', descriptor('coalesced'));
    assert.notEqual(oldQueuedMode.id, newQueuedMode.id);
    started[startOffset].gate.resolve(); started[startOffset + 1].gate.resolve();
    await until(() => [oldQueuedMode, newQueuedMode].every(job => service.get('owner', job.id)?.status === 'success'));
    assert.equal(started.filter(entry => entry.title === 'coalesced').length, 1, 'queued mode changes still coalesce actual execution through persistence');

    const legacyID = crypto.randomUUID();
    await fs.writeFile(path.join(directory, legacyID + '.json'), JSON.stringify({ id: legacyID, ownerId: 'owner',
      key: descriptorKey(descriptor('legacy')), descriptor: descriptor('legacy'), status: 'success',
      metadata: { title: 'old display', localizationVersion: LOCALIZATION_VERSION } }));
    const policyID = crypto.randomUUID();
    await fs.writeFile(path.join(directory, policyID + '.json'), JSON.stringify({ id: policyID, ownerId: 'owner',
      key: descriptorKey(descriptor('old-policy')), descriptor: descriptor('old-policy'), status: 'success', scrapeMode: 'web',
      scrapePolicyVersion: 0, inputFingerprint: cache.inputFingerprint(descriptor('old-policy')), metadata: { title: 'old policy display' } }));
    const pendingID = crypto.randomUUID();
    await fs.writeFile(path.join(directory, pendingID + '.json'), JSON.stringify({ id: pendingID, ownerId: 'owner',
      key: descriptorKey(descriptor('restored-pending')), descriptor: descriptor('restored-pending'), status: 'running',
      scrapeMode: 'traditional', scrapePolicyVersion: 1, inputFingerprint: cache.inputFingerprint(descriptor('restored-pending')) }));
    const restoredRuns = [];
    const restored = createLocalMetadataService({ directory, runAsUser: (_, operation) => operation(), resolve: async value => {
      restoredRuns.push(value.title);
      assert.equal(config.AI_API_KEY, 'fixture-secret-a');
      assert.equal(context.currentContext().mode, 'web');
      return { title: value.title, localizationVersion: LOCALIZATION_VERSION };
    } });
    await restored.initialize();
    await until(() => restored.get('owner', pendingID)?.status === 'success');
    assert.equal(restored.get('owner', pendingID).scrapeMode, 'web', 'restored unfinished jobs capture current mode/credentials');
    assert.equal((await restored.submit('owner', descriptor('fallback'))).id, fallback.id, 'completed web fallback survives restart');
    assert.equal((await restored.submit('owner', descriptor('partial'))).id, partial.id, 'partial results survive restart without repeating localization');
    assert.equal(restored.get('owner', partial.id).scrapeCompletion, 'partial');
    assert.equal(restored.get('owner', partial.id).scrapeReason, '主作品已确认，卷册仅中文化');
    assert.equal(restored.get('owner', legacyID).metadata.title, 'old display');
    const upgraded = await restored.submit('owner', descriptor('legacy'));
    assert.equal(upgraded.id, legacyID, 'legacy completed jobs remain reusable without policy stamps');
    await until(() => restored.get('owner', upgraded.id)?.status === 'success');
    const policyUpgrade = await restored.submit('owner', descriptor('old-policy'));
    assert.equal(policyUpgrade.id, policyID);
    await until(() => restored.get('owner', policyUpgrade.id)?.status === 'success');
    assert.deepEqual(restoredRuns, ['restored-pending']);
    for (const name of await fs.readdir(directory)) {
      const serialized = await fs.readFile(path.join(directory, name), 'utf8');
      for (const forbidden of ['fixture-secret', 'fixture-bangumi', 'aiApiKey', 'aiBaseUrl', 'fixture.invalid']) assert.ok(!serialized.includes(forbidden));
    }
    console.log('Scrape context/cache: fixed settings, queue isolation, live limits, exact web namespace, no-ID results, device mode/fingerprint reuse, fallback and restart passed.');
  } finally {
    store.snapshot = original.snapshot; store.secrets = original.secrets; global.fetch = original.fetch;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
