const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareSettings } = require('./settings-fixture');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-search-evidence-'));
  process.env.DATA_DIR = root; prepareSettings({ dataRoot: root, sources: [] });
  const ai = require('../lib/aiProvider');
  const originalFetch = global.fetch;
  const options = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model', concurrency: 2 };
  const messages = [{ role: 'user', content: 'scrape test' }];
  let payload, requests = 0;
  const answer = (status, calls = []) => ({ id: 'response-fixture', status: 'completed', output: [
    ...calls, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ schemaVersion: 1, status,
      work: status === 'failed' ? null : { name: 'fixture' }, reason: status === 'failed' ? '无法确认作品' : '' }) }] },
  ] });
  global.fetch = async (_, request) => {
    requests++;
    assert.equal(JSON.parse(request.body).allowUnverifiedResult, undefined, 'local validation flag is never sent upstream');
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify(payload));
  };
  try {
    payload = answer('failed');
    const [candidate, strict] = await Promise.allSettled([
      ai.webSearch({ messages, allowUnverifiedResult: true }, options), ai.webSearch({ messages }, options),
    ]);
    assert.equal(requests, 2, 'strict and engine-only validation cannot share an unchecked result');
    assert.equal(candidate.status, 'fulfilled');
    assert.equal(candidate.value.searchCalls, 0); assert.deepEqual(candidate.value.sources, []);
    assert.equal(JSON.parse(candidate.value.text).status, 'failed', 'engine receives the model failure directly');
    assert.equal(strict.status, 'rejected'); assert.match(strict.reason.message, /真实/);
    await assert.rejects(ai.testWebSearch({ ...options, allowUnverifiedResult: true }), /真实/);
    for (const status of ['success', 'partial']) {
      payload = answer(status);
      assert.equal(JSON.parse((await ai.webSearch({ messages, allowUnverifiedResult: true }, options)).text).status, status);
      payload = answer(status, [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } }]);
      assert.equal(JSON.parse((await ai.webSearch({ messages, allowUnverifiedResult: true }, options)).text).status, status);
    }
    payload = answer('failed'); payload.status = 'incomplete';
    await assert.rejects(ai.webSearch({ messages, allowUnverifiedResult: true }, options), /完整/);
    payload = answer('failed'); payload.output[0].content[0].text = '{"status":"failed"';
    assert.equal((await ai.webSearch({ messages, allowUnverifiedResult: true }, options)).text, '{"status":"failed"');

    const search = { id: 'search-1', type: 'web_search_call', status: 'completed', action: { type: 'search',
      queries: ['fixture novel publisher'], sources: [{ type: 'url', url: 'https://publisher.example/books/1', title: 'Publisher', snippet: 'Original source details' }] } };
    const opened = { id: 'open-1', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://publisher.example/books/1/volumes' } };
    const failedCall = { id: 'search-failed', type: 'web_search_call', status: 'failed', action: { type: 'search', sources: [{ url: 'https://unverified.example/' }] } };
    const annotations = [{ type: 'url_citation', url: 'https://bgm.tv/subject/1', title: 'Bangumi', start_index: 0, end_index: 10 }];
    payload = answer('partial', [search, opened, failedCall]);
    payload.output.at(-1).content[0].annotations = annotations;
    const result = await ai.webSearch({ messages, allowUnverifiedResult: true }, options);
    assert.equal(result.responseId, 'response-fixture'); assert.equal(result.searchCalls, 1);
    assert.deepEqual(result.searchCallDetails, [search, opened, failedCall]);
    assert.deepEqual(result.annotations, annotations);
    assert.equal(result.toolSources.length, 2);
    assert.equal(result.toolSources[0].snippet, 'Original source details');
    assert.equal(result.toolSources[0].callId, 'search-1'); assert.equal(result.toolSources[1].actionType, 'open_page');
    assert.ok(!result.sources.some(source => source.url.includes('unverified.example')));
    assert.equal(result.sources.length, 3, 'legacy aggregate sources remain available alongside provenance');
    const before = requests;
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => ai.webSearch({ messages, allowUnverifiedResult: true }, options)));
    assert.equal(requests - before, 1);
    duplicates[0].searchCallDetails[0].action.sources[0].title = 'mutated';
    assert.equal(duplicates[1].searchCallDetails[0].action.sources[0].title, 'Publisher');
    console.log('Web search evidence: direct-result opt-in, strict connection-test isolation, success/partial telemetry, complete tool provenance and deduplication passed.');
  } finally {
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
