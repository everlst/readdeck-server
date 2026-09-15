// Integration tests accelerate only the queue clock; request deadlines stay real.
// ai-scheduling-test exercises controlled time and the production 3-second clock.
const { performance } = require('node:perf_hooks');
const queue = require('../../lib/aiSendQueue');
const create = queue.createSendQueue;
queue.createSendQueue = options => create(options || {
  now: () => performance.now() * 1000,
  setTimer: (work, ms) => setTimeout(work, Math.ceil(ms / 1000)),
  clearTimer: clearTimeout,
});
