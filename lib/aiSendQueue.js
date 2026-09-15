const { performance } = require('node:perf_hooks');

const MIN_SEND_INTERVAL_MS = 3000;

function createSendQueue({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = [];
  let active = 0, concurrency = 4, lastSent = -Infinity, wakeup = null;
  function drain() {
    if (wakeup !== null) { clearTimer(wakeup); wakeup = null; }
    if (!pending.length || active >= concurrency) return;
    const remaining = MIN_SEND_INTERVAL_MS - (now() - lastSent);
    if (remaining > 0) {
      wakeup = setTimer(() => { wakeup = null; drain(); }, remaining);
      return;
    }
    const job = pending.shift();
    active++;
    lastSent = now();
    // Start the transport here; queued time never consumes a request deadline.
    let result;
    try { result = job.work(); } catch (error) { result = Promise.reject(error); }
    lastSent = now();
    Promise.resolve(result).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    drain();
  }
  function insert(job) {
    const index = pending.findIndex(other => other.priority < job.priority);
    if (index < 0) pending.push(job); else pending.splice(index, 0, job);
  }
  return {
    setConcurrency(limit) {
      concurrency = Math.max(1, Math.min(12, Math.floor(Number(limit) || 4)));
      drain();
    },
    enqueue(work, key, priority = 0) {
      return new Promise((resolve, reject) => { insert({ work, key, priority, resolve, reject }); drain(); });
    },
    promote(key, priority) {
      const index = pending.findIndex(job => job.key === key && job.priority < priority);
      if (index < 0) return;
      const [job] = pending.splice(index, 1);
      job.priority = priority;
      insert(job);
    },
  };
}

module.exports = { MIN_SEND_INTERVAL_MS, createSendQueue };
