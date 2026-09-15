const fs = require('fs').promises;
const path = require('path');
const store = require('./settingsStore');
const { safePath } = require('./utils');

function sourceFor(resource) {
  const sources = store.snapshot().sources.filter(s => s.enabled);
  return resource?.sourceId
    ? sources.find(s => s.id === resource.sourceId)
    : sources.find(s => resource?.sourcePath && store.contains(s.path, path.resolve(resource.sourcePath)));
}
async function allowedPath(source, target, { allowRoot = false } = {}) {
  if (!source) throw Object.assign(new Error('资源不在启用的书库来源内'), { status: 403 });
  const status = await store.sourceStatus(source);
  if (!status.available) throw Object.assign(new Error('来源目录不可访问'), { status: 404 });
  const lexical = path.resolve(target);
  if ((!store.contains(source.path, lexical) && !store.contains(status.realPath, lexical)) || (!allowRoot && (lexical === source.path || lexical === status.realPath))) throw Object.assign(new Error('路径超出来源目录'), { status: 403 });
  const real = await fs.realpath(lexical);
  if (!store.contains(status.realPath, real) || (!allowRoot && real === status.realPath)) throw Object.assign(new Error('真实路径超出来源目录'), { status: 403 });
  return real;
}
async function resourcePath(resource) {
  const source = sourceFor(resource);
  const target = resource?.sourceId
    ? safePath(source?.path || '/', resource.relativePath || '')
    : resource?.sourcePath;
  return allowedPath(source, target || '');
}
async function validateResource(resource) {
  if (!resource) throw Object.assign(new Error('资源不存在'), { status: 404 });
  const sourcePath = await resourcePath(resource);
  const stat = await fs.stat(sourcePath);
  return { ...resource, sourcePath, sourceRevision: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
}
async function seriesDirectory(bundle) {
  const resource = bundle?.resources?.find(r => sourceFor(r));
  if (!resource) throw Object.assign(new Error('作品来源不可用'), { status: 404 });
  const source = sourceFor(resource);
  const relative = resource.seriesRelativePath ?? bundle.series?.legacy?.relativeDirectory;
  if (relative === undefined) throw Object.assign(new Error('需要重新索引此作品'), { status: 409 });
  return allowedPath(source, safePath(source.path, relative), { allowRoot: true });
}
async function seriesPath(bundle, ...segments) {
  const root = await seriesDirectory(bundle);
  const source = sourceFor(bundle.resources.find(r => sourceFor(r)));
  return allowedPath(source, safePath(root, ...segments), { allowRoot: false });
}
async function metadataPaths(resources) {
  const out = new Set();
  for (const resource of resources || []) {
    if (resource.seriesRelativePath === undefined) continue;
    try {
      const source = sourceFor(resource);
      const target = safePath(source.path, resource.seriesRelativePath, '元数据.json');
      out.add(await allowedPath(source, target));
    } catch {}
  }
  return [...out];
}
module.exports = { sourceFor, allowedPath, resourcePath, validateResource, seriesDirectory, seriesPath, metadataPaths };
