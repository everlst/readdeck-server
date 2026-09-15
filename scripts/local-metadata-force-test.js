const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareSettings } = require('./settings-fixture');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for force fixture');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readdeck-local-force-'));
  process.env.DATA_DIR = root; prepareSettings({ dataRoot: root, sources: [] });
  const { createLocalMetadataService, descriptorKey, descriptorScrapeIdentity } = require('../lib/localMetadata');
  const { LOCALIZATION_VERSION } = require('../lib/metadataLocalization');
  const directory = path.join(root, 'jobs'), calls = [];
  const description = { title: '原始书名', author: '原始作者', originalName: '原始书名 01.epub', mediaType: 'novel' };
  const resolver = async (value, options) => {
    assert.deepEqual(Object.keys(value).sort(), ['author', 'mediaType', 'originalName', 'title']);
    assert.equal(typeof options.force, 'boolean');
    const call = { value, options, gate: deferred(), revision: calls.length + 1 }; calls.push(call);
    const error = await call.gate.promise;
    if (error) throw error;
    return { localizationVersion: LOCALIZATION_VERSION, title: value.title, revision: call.revision };
  };
  const create = () => createLocalMetadataService({ directory, runAsUser: (_, operation) => operation(), resolve: resolver });
  const service = create();
  try {
    await service.initialize();
    const ordinary = await service.submit('owner', description);
    await until(() => calls.length === 1);
    assert.equal(ordinary.force, false); assert.equal(calls[0].options.force, false);
    assert.equal((await service.submit('owner', description)).id, ordinary.id);
    const forced = await service.submit('owner', description, { force: true });
    await until(() => calls.length === 2);
    assert.notEqual(forced.id, ordinary.id, 'force must not join a running ordinary request');
    assert.equal(forced.force, true); assert.equal(calls[1].options.force, true);
    const repeated = await Promise.all(Array.from({ length: 12 }, () => service.submit('owner', description, { force: true })));
    assert.ok(repeated.every(job => job.id === forced.id), 'duplicate running force requests share a job');
    assert.equal((await service.submit('owner', description)).id, ordinary.id, 'ordinary must not join force execution');
    calls[1].gate.resolve();
    await until(() => service.get('owner', forced.id)?.status === 'success');
    calls[0].gate.resolve();
    await until(() => service.get('owner', ordinary.id)?.status === 'success');
    assert.equal((await service.submit('owner', description)).id, forced.id, 'a late old request cannot replace the newer refresh');
    assert.equal(service.get('owner', ordinary.id).metadata.revision, 1, 'old records remain readable');

    const forcedAgain = await service.submit('owner', description, { force: true });
    assert.notEqual(forcedAgain.id, forced.id, 'completed force results cannot satisfy a new force request');
    await until(() => calls.length === 3);
    assert.equal(calls[2].options.force, true, 'force bypasses pump completed-result reuse');
    calls[2].gate.resolve(new Error('new scrape failed'));
    await until(() => service.get('owner', forcedAgain.id)?.status === 'failed');
    assert.equal((await service.submit('owner', description)).id, forced.id, 'failure preserves the last successful result');

    const blockers = await Promise.all(['block-a', 'block-b'].map(title => service.submit('owner', { ...description, title })));
    await until(() => calls.length === 5);
    const queuedDescription = { ...description, title: 'queued' };
    const queued = await service.submit('owner', queuedDescription, { force: true });
    assert.equal(queued.status, 'queued');
    assert.equal((await service.submit('owner', queuedDescription, { force: true })).id, queued.id);
    const queuedOrdinary = await service.submit('owner', queuedDescription);
    assert.notEqual(queuedOrdinary.id, queued.id, 'force and ordinary queues remain separate');
    calls[3].gate.resolve(); calls[4].gate.resolve();
    await until(() => calls.length === 7);
    assert.deepEqual(calls.slice(5).map(call => call.options.force).sort(), [false, true], 'execution coalescing includes force');
    calls[5].gate.resolve(); calls[6].gate.resolve();
    await until(() => [...blockers, queued, queuedOrdinary].every(job => service.get('owner', job.id)?.status === 'success'));

    // Restart with a forced queued request for already completed input. It must
    // retain force and run again; a missing flag on legacy records means false.
    const pendingID = crypto.randomUUID();
    await fs.writeFile(path.join(directory, pendingID + '.json'), JSON.stringify({ id: pendingID, ownerId: 'owner',
      descriptor: description, key: descriptorKey(description), ...descriptorScrapeIdentity(description),
      force: true, status: 'running', createdAt: new Date().toISOString() }));
    const restored = create(); await restored.initialize();
    await until(() => calls.length === 8);
    assert.equal(restored.get('owner', pendingID).force, true); assert.equal(calls[7].options.force, true);
    assert.equal((await restored.submit('owner', description, { force: true })).id, pendingID);
    calls[7].gate.resolve(); await until(() => restored.get('owner', pendingID)?.status === 'success');
    assert.equal((await restored.submit('owner', description)).id, pendingID);
    for (const name of await fs.readdir(directory)) {
      const job = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      assert.equal(typeof job.force, 'boolean', 'persist only a safe boolean force flag');
      assert.deepEqual(Object.keys(job.descriptor).sort(), ['author', 'mediaType', 'originalName', 'title']);
    }
    console.log('Local metadata force: fresh execution, normal/force isolation, queued/running dedup, option forwarding, latest success, failure retention and restart passed.');
  } finally {
    for (const call of calls) call.gate.resolve();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
