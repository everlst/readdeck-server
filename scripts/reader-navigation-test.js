const assert = require('node:assert/strict');
const { start } = require('./reader-navigation-fixture');
const { app } = require('../public/app');

async function main() {
  const fixture = await start({ port: 16000 + Math.floor(Math.random() * 10000) });
  try {
    async function request(route, token, options = {}) {
      const response = await fetch(fixture.base + route, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const text = await response.text();
      assert.equal(response.ok, true, `${response.status} ${route}: ${text}`);
      return JSON.parse(text);
    }
    const login = async credentials => (await request('/api/login', '', {
      method: 'POST', body: JSON.stringify(credentials),
    })).token;
    const token = await login(fixture.credentials);
    const detail = await request(`/api/comics/${fixture.seriesId}`, token);
    const volumes = detail.groups.volumes;
    assert.equal(volumes.length, 10);
    for (const volume of volumes) {
      assert.ok(volume.bookKey, `${volume.resourceId} must identify its logical book`);
      assert.equal(volume.sourceId, volume.resourceId.startsWith('a') ? 'source-a' : 'source-b');
    }
    const volume = id => volumes.find(item => item.resourceId === id);
    for (let number = 1; number <= 4; number++) {
      assert.equal(volume(`a${number}`).bookKey, volume(`b${number}`).bookKey);
    }
    assert.equal(new Set(volumes.map(item => item.bookKey)).size, 6);
    for (const [resourceId, pageCount] of [['a1', 3], ['b1', 2]]) {
      const pages = await request(`/api/resources/${resourceId}/pages`, token);
      assert.equal(pages.pages.length, pageCount);
      const image = await fetch(fixture.base + pages.pages[0], { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(image.ok, true, `${resourceId} must have readable fixture images`);
      assert.match(image.headers.get('content-type'), /^image\//);
      await image.arrayBuffer();
    }
    app.state.currentComic = detail;
    app.state.currentGroup = 'volumes';
    app.state.allChapters = [];
    const fromA = app.readerChapterList(volume('a1'), {});
    const fromB = app.readerChapterList(volume('b1'), {});
    assert.deepEqual(fromA.map(item => item.resourceId), ['a1', 'a2', 'a3', 'a4', 'b5', 'a6']);
    assert.deepEqual(fromB.map(item => item.resourceId), ['b1', 'b2', 'b3', 'b4', 'b5', 'a6']);
    assert.deepEqual(app.readerChapterList(volume('b5'), { chapterList: fromA }).map(item => item.resourceId),
      ['a1', 'a2', 'a3', 'a4', 'b5', 'a6'], 'a fallback must preserve the session queue');
    assert.equal(fromA.some(item => item.contentType !== 'volume'), false);
    const ordinaryChapters = Object.entries(detail.groups).find(([key]) => key !== 'volumes');
    assert.ok(ordinaryChapters, 'fixture must include ordinary chapters');
    app.state.currentGroup = ordinaryChapters[0];
    assert.equal(app.readerChapterList(ordinaryChapters[1][0], {}).length, 2);

    const progressRoute = `/api/progress/${fixture.seriesId}`;
    assert.deepEqual(await request(`${progressRoute}?resourceId=a2`, token), {}, 'unread resource has no saved page');
    for (const [resourceId, page, cfi] of [['a1', 2, 'epubcfi(/6/2!/4/2:20)'], ['b1', 1, 'epubcfi(/6/2!/4/2:10)']]) {
      await request(progressRoute, token, {
        method: 'PUT', body: JSON.stringify({
          chapterUuid: 'shared-volume-chapter', chapterTitle: '第1册', groupName: '单行本',
          resourceId, resourceType: 'epub', page, cfi,
        }),
      });
    }
    const aProgress = await request(`${progressRoute}?resourceId=a1`, token);
    const bProgress = await request(`${progressRoute}?resourceId=b1`, token);
    assert.equal(aProgress.lastPage, 2);
    assert.equal(bProgress.lastPage, 1);
    assert.equal(aProgress.lastResourceId, 'a1');
    assert.equal(bProgress.lastResourceId, 'b1');
    assert.equal(aProgress.lastCfi, 'epubcfi(/6/2!/4/2:20)');
    assert.equal(bProgress.lastCfi, 'epubcfi(/6/2!/4/2:10)');
    assert.equal(aProgress.chapters['shared-volume-chapter'].page, 2);
    assert.equal(bProgress.chapters['shared-volume-chapter'].page, 1);

    const readerToken = await login(fixture.readerCredentials);
    const restricted = await request(`/api/comics/${fixture.seriesId}`, readerToken);
    assert.deepEqual(restricted.groups.volumes.map(item => item.resourceId), ['a1', 'a2', 'a3', 'a4', 'a6']);
    assert.equal(restricted.groups.volumes.every(item => item.sourceId === 'source-a'), true);
    const deniedProgress = await fetch(fixture.base + `${progressRoute}?resourceId=b1`, {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    assert.equal(deniedProgress.status, 404, 'resource progress must respect source access');
    await request(progressRoute, readerToken, {
      method: 'PUT', body: JSON.stringify({ chapterUuid: 'shared-volume-chapter', resourceId: 'a1', page: 1 }),
    });
    const readerProgress = await request(progressRoute, readerToken);
    assert.deepEqual(Object.keys(readerProgress.resources), ['a1']);
    assert.equal((await request(`${progressRoute}?resourceId=a1`, readerToken)).lastPage, 1);
    console.log('reader navigation and resource progress ok');
  } finally {
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
