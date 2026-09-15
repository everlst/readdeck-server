const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { start } = require('./detail-ui-fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const fixture = await start({ port });
  const streams = [];
  async function request(url, token, method = 'GET', body) {
    const response = await fetch(fixture.base + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const login = async (username, password) => (await request('/api/login', '', 'POST', { username, password })).data.token;
  async function listen(token) {
    const controller = new AbortController(), events = [];
    const response = await fetch(fixture.base + '/api/events', { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });
    const reader = response.body.getReader();
    const job = (async () => { let buffer = ''; const decoder = new TextDecoder();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        let split; while ((split = buffer.indexOf('\n\n')) >= 0) { events.push(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
      } } catch { /* explicitly aborted below */ }
    })();
    streams.push({ controller, job }); return events;
  }
  try {
    const admin = await login('admin', 'test-password'), reader = await login('detail-reader', 'reader-password');
    assert.equal((await request('/api/me/preferences', '')).status, 401);
    const initial = (await request('/api/me/preferences', reader)).data;
    assert.deepEqual(initial.detailSections.map(row => row.id), ['characters', 'persons', 'relations']);
    assert(initial.detailSections.every(row => row.visible));
    const adminEvents = await listen(admin), firstEvents = await listen(reader), secondEvents = await listen(reader);
    const changed = { ...initial, detailSections: [...initial.detailSections].reverse().map(row => ({ ...row, visible: false })) };
    const saved = await request('/api/me/preferences', reader, 'PUT', changed);
    assert.equal(saved.status, 200); assert.equal(saved.data.revision, initial.revision + 1);
    for (let index = 0; index < 100 && !secondEvents.some(event => event.includes('preferences_changed')); index++) await delay(10);
    assert(firstEvents.some(event => event.includes('preferences_changed')));
    assert(secondEvents.some(event => event.includes('preferences_changed')));
    assert(!adminEvents.some(event => event.includes('preferences_changed')), 'other accounts never receive private preference events');
    assert.equal((await request('/api/verify', reader)).status, 200, 'saving display preferences does not revoke login');
    assert.deepEqual((await request('/api/me/preferences', admin)).data, initial, 'admin preferences are independent');
    assert.equal((await request('/api/settings', reader)).status, 403);
    assert.equal((await request('/api/me/preferences', reader, 'PUT', changed)).status, 409);
    assert.equal((await request('/api/me/preferences', reader, 'PUT', { ...saved.data, detailSections: [saved.data.detailSections[0]] })).status, 400);
    const concurrent = await Promise.all([request('/api/me/preferences', reader, 'PUT', saved.data), request('/api/me/preferences', reader, 'PUT', saved.data)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
    const final = (await request('/api/me/preferences', reader)).data;
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.root, 'data/users', fixture.readerId, 'preferences.json'), 'utf8')), final);
    const reconnected = await listen(reader);
    assert.equal((await request('/api/me/preferences', reader)).data.revision, final.revision);
    await request('/api/me/preferences', reader, 'PUT', { ...initial, revision: final.revision });
    for (let index = 0; index < 100 && !reconnected.some(event => event.includes('preferences_changed')); index++) await delay(10);
    assert(reconnected.some(event => event.includes('preferences_changed')));
    console.log('user preferences ok: defaults, reader access, isolation, persistence, concurrent revisions, same-user SSE and reconnect');
  } finally { streams.forEach(stream => stream.controller.abort()); await Promise.all(streams.map(stream => stream.job)); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
