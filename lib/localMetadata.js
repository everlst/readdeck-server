const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./runtimePaths');
const { atomicWrite } = require('./settingsStore');
const { titleKey, withLock } = require('./metadataCache');
const { captureContext, withScrapeContext, scrapePolicy, inputFingerprint, credential } = require('./scrapeContext');
const { withPriority } = require('./aiProvider');

function describe(input) {
  const allowed = new Set(['title', 'author', 'originalName', 'mediaType']);
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) fail('只接受书籍描述，不接收文件、图片、正文或文件路径');
  const string = (key, limit, required = false) => {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f]/.test(value) || (required && !value.trim())) fail('书籍描述字段无效：' + key);
    return value.trim();
  };
  const descriptor = { title: string('title', 256, true), author: string('author', 256), originalName: string('originalName', 512), mediaType: input.mediaType };
  if (!['comic', 'novel'].includes(descriptor.mediaType)) fail('资源类型无效');
  if (/[\\/]/.test(descriptor.originalName)) fail('仅发送文件名，不接受文件路径');
  return descriptor;
}
function descriptorKey(value) {
  return crypto.createHash('sha256').update(JSON.stringify([value.mediaType, titleKey(value.title),
    value.author.normalize('NFKC').toLowerCase(), value.originalName.normalize('NFKC')])).digest('hex');
}
function descriptorScrapeIdentity(descriptor, policy = scrapePolicy()) {
  return { scrapeMode: policy.mode, scrapePolicyVersion: policy.policyVersion, inputFingerprint: inputFingerprint(descriptor) };
}
function sameScrape(job, identity) {
  return ['scrapeMode', 'scrapePolicyVersion', 'inputFingerprint'].every(field => job[field] === identity[field]);
}
function completedFor(job, identity) {
  return job.status === 'success' && !!job.metadata &&
    (job.inputFingerprint || inputFingerprint(job.descriptor)) === identity.inputFingerprint;
}
function failureMessage(error, context) {
  let message = String(error?.message || '刮削失败');
  if (context) withScrapeContext(context, () => {
    for (const name of ['aiApiKey', 'bangumiToken']) {
      const value = credential(name);
      if (value) message = message.split(value).join('[redacted]');
    }
  });
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 500);
}

function createLocalMetadataService({ resolve, runAsUser, directory = path.join(DATA_DIR, 'metadata', 'local-requests') }) {
  const jobs = new Map(), queue = [], resolving = new Map();
  let active = 0;
  const file = id => path.join(directory, id + '.json');
  const view = job => ({ id: job.id, status: job.status, force: job.force === true, metadata: job.metadata || null, error: job.error || '', reused: !!job.metadata?.reused,
    scrapeMode: job.scrapeMode, scrapePolicyVersion: job.scrapePolicyVersion, inputFingerprint: job.inputFingerprint,
    scrapeCompletion: job.scrapeCompletion, scrapeReason: job.scrapeReason });
  const save = job => atomicWrite(file(job.id), job);
  const latestCompleted = (ownerId, identity, excludeId) => [...jobs.values()].reverse()
    .filter(job => job.ownerId === ownerId && job.id !== excludeId && completedFor(job, identity))
    // A background request that finishes late cannot supersede a newer manual refresh.
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')) ||
      Number(right.force === true) - Number(left.force === true) ||
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); active++;
      let context;
      (async () => {
        // The queue stores only safe policy labels. Capture credentials here,
        // even for a restored task, never at submit/serialization time.
        await runAsUser(job.ownerId, () => {
          context = captureContext();
          return withScrapeContext(context, () => withPriority(1, async () => {
            const identity = descriptorScrapeIdentity(job.descriptor, context);
            Object.assign(job, identity, { status: 'running' }); await save(job);
            const reusable = job.force ? null : latestCompleted(job.ownerId, identity, job.id);
            const key = JSON.stringify([job.ownerId, identity, job.force === true]);
            let execution;
            try {
              let metadata;
              if (reusable) metadata = { ...structuredClone(reusable.metadata), reused: true };
              else {
                // Tasks enqueued under different settings can start in the same
                // mode; coalesce through persistence, not just provider completion.
                execution = resolving.get(key);
                if (!execution) {
                  execution = { users: 0, promise: Promise.resolve().then(() => resolve(job.descriptor, { force: job.force === true })) };
                  resolving.set(key, execution);
                }
                execution.users++;
                metadata = structuredClone(await execution.promise);
              }
              if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('刮削未返回有效的元数据');
              const completed = { ...job, ...(reusable ? { scrapeMode: reusable.scrapeMode,
                scrapePolicyVersion: reusable.scrapePolicyVersion } : {}), metadata, status: 'success', error: '',
                scrapeCompletion: metadata.scrapeStatus || (metadata.fallback ? 'fallback' : 'success'),
                scrapeReason: metadata.fallbackReason || metadata.reason || '', updatedAt: new Date().toISOString() };
              await save(completed); Object.assign(job, completed);
            } finally {
              if (execution && --execution.users === 0) resolving.delete(key);
            }
          }));
        });
      })().catch(async error => {
        const failed = { ...job, status: 'failed', error: failureMessage(error, context), updatedAt: new Date().toISOString() };
        try { await save(failed); } catch { /* The client can retry after storage recovers. */ }
        Object.assign(job, failed);
      }).finally(() => {
        active--; pump();
      });
    }
  }
  return {
    async initialize() {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      for (const name of await fs.readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const job = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
          if (job.id + '.json' !== name || !job.ownerId) continue;
          job.descriptor = describe(job.descriptor); job.force = job.force === true; jobs.set(job.id, job);
          if (['queued', 'running'].includes(job.status)) { job.status = 'queued'; queue.push(job); }
        } catch { /* An invalid job never becomes a resource or an executable request. */ }
      }
      pump();
    },
    async submit(ownerId, input, { force = false } = {}) {
      force = force === true;
      const descriptor = describe(input), key = descriptorKey(descriptor);
      return withLock(`request:${ownerId}:${key}`, async () => {
      const identity = descriptorScrapeIdentity(descriptor);
      const existing = [...jobs.values()].find(job => job.ownerId === ownerId && job.key === key && job.force === force &&
        ['queued', 'running'].includes(job.status) && sameScrape(job, identity)) || (!force && latestCompleted(ownerId, identity));
      if (existing) return { ...view(existing), reused: existing.status === 'success' || !!existing.metadata?.reused };
      if ([...jobs.values()].filter(job => job.ownerId === ownerId && ['queued', 'running'].includes(job.status)).length >= 50) throw Object.assign(new Error('待处理的刮削任务过多，请稍后重试'), { status: 429 });
      const job = { id: crypto.randomUUID(), ownerId, key, descriptor, ...identity, force, status: 'queued', createdAt: new Date().toISOString() };
      await save(job); jobs.set(job.id, job); queue.push(job); pump(); return view(job);
      });
    },
    get(ownerId, id) { const job = jobs.get(id); return job?.ownerId === ownerId ? view(job) : null; },
  };
}
module.exports = { describe, descriptorKey, descriptorScrapeIdentity, createLocalMetadataService };
