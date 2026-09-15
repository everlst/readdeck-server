const crypto = require('crypto');
const { Agent } = require('undici');
const { AsyncLocalStorage } = require('async_hooks');
const debug = require('./debugLog');

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LABELS = { none: '无', low: '低', medium: '中', high: '高' };
const catalogs = new Map();
const inFlight = new Map();
const requestDispatchers = new Map();
const sendQueue = require('./aiSendQueue').createSendQueue();
const priorityContext = new AsyncLocalStorage();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function setConcurrency(limit) {
  sendQueue.setConcurrency(limit);
}
function limited(work, limit, key) {
  // Retry options may carry the task's old concurrency value. The service-wide
  // limit remains live even while its model, credentials and mode are fixed.
  if (require('./scrapeContext').currentContext()) limit = require('./config').AI_MAX_CONCURRENCY;
  setConcurrency(limit);
  return sendQueue.enqueue(AsyncLocalStorage.bind(work), key, priorityContext.getStore() || 0);
}
function withPriority(priority, work) { return priorityContext.run(priority, work); }
function promotePending(key) {
  sendQueue.promote(key, priorityContext.getStore() || 0);
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('AI 接口地址无效');
  let url;
  try { url = new URL(value.trim()); } catch { fail('AI 接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('接口地址必须是无凭据、查询参数或片段的 HTTP(S) URL');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models|responses)$/, '') || '/v1';
  return url.href.replace(/\/+$/, '');
}

function apiKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) fail('API Key 格式无效');
  return value.trim();
}

function connection(input, settings, secrets) {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? settings.metadata.aiBaseUrl);
  let key = apiKey(input.apiKey ?? '');
  if (input.clearApiKey === true) key = '';
  else if (!key) {
    if (baseUrl !== normalizeBaseUrl(settings.metadata.aiBaseUrl)) fail('更换接口地址后，请重新输入 API Key');
    key = secrets.aiApiKey || '';
  }
  if (!key) fail('请先填写 AI API Key');
  return { baseUrl, apiKey: key };
}

function reasoning(model) {
  const advertised = model.supported_reasoning_efforts ?? model.reasoning_efforts ?? model.reasoning?.efforts ?? model.capabilities?.reasoning_efforts;
  let values = [], source = 'default';
  if (Array.isArray(advertised)) {
    values = EFFORTS.filter(value => advertised.some(item => (typeof item === 'string' ? item : item?.effort) === value));
    source = 'provider';
  } else {
    // Exact documented families and dated snapshots only; unknown models use the four standard choices.
    // https://developers.openai.com/api/docs/models/{model} (verified 2026-09-08)
    const id = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const profiles = [
      [/^gpt-6-astra$/, ['low', 'medium', 'high', 'xhigh', 'max']],
      [/^gpt-5\.6-(?:sol|terra)$/, ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      [/^(?:gpt-5\.(?:4|5)|gpt-5\.4-mini)$/, ['none', 'low', 'medium', 'high', 'xhigh']],
      [/^gpt-5\.1$/, ['none', 'low', 'medium', 'high']],
      [/^gpt-5(?:-mini|-nano)?$/, ['minimal', 'low', 'medium', 'high']],
      [/^(?:o1|o3|o3-mini|o4-mini)$/, ['low', 'medium', 'high']],
    ];
    const profile = profiles.find(([pattern]) => pattern.test(id));
    if (profile) { values = profile[1]; source = 'profile'; }
  }
  const options = Object.entries(LABELS).map(([value, label]) => ({ value, label, disabled: source !== 'default' && !values.includes(value) }));
  return { source, options, defaultEffort: options.find(option => !option.disabled)?.value || 'none' };
}

function searchFailure(message, payload, settings, extra = {}) {
  const response = payload?.response || payload;
  const error = response?.error || payload?.error || payload;
  // Only report diagnostic fields, never the full response, prompt or credentials.
  const redact = value => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    let text = String(value);
    const key = settings.apiKey?.trim();
    if (key) text = text.split(key).join('[REDACTED]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[\w-]+/g, '[REDACTED]')
      .replace(/[\r\n\t]/g, ' ').slice(0, 500);
  };
  const output = Array.isArray(response?.output) ? response.output : [];
  const details = Object.fromEntries(Object.entries({
    ...extra, event: typeof payload?.type === 'string' && (payload.type.startsWith('response.') || payload.type === 'error') ? payload.type : undefined,
    responseId: response?.id, status: response?.status, code: error?.code ?? extra.code,
    message: error?.message, param: error?.param, incompleteReason: response?.incomplete_details?.reason,
    outputTypes: Array.isArray(response?.output) ? output.map(item => item?.type).join(',') || '(empty)' : undefined,
    webSearchCalls: Array.isArray(response?.output) ? output.filter(item => item?.type === 'web_search_call')
      .map(item => (item.status || 'unknown') + ':' + (item.action?.type || 'unknown')).join(',') || '(none)' : undefined,
  }).map(([key, value]) => [key, redact(value)]).filter(([, value]) => value !== undefined));
  debug.log('ai.search.failed', { reason: message, details }, [settings.apiKey]);
  throw Object.assign(new Error(message + (Object.keys(details).length ? '；详情: ' + JSON.stringify(details) : '')),
    { status: 502, summary: message, details });
}

async function request(connection, endpoint, body, timeout = 20000) {
  let response, reader;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('AI request timed out', 'TimeoutError')), timeout);
  // Race the transport against a wall-clock deadline as some compatible stream
  // implementations do not reject a pending read when their fetch is aborted.
  const withinDeadline = operation => new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(controller.signal.reason); };
    const cleanup = () => controller.signal.removeEventListener('abort', abort);
    controller.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (controller.signal.aborted) abort();
  });
  const read = () => withinDeadline(reader.read());
  const requestId = debug.requestId(), started = Date.now();
  const log = (event, details) => debug.log(event, { requestId, endpoint, elapsedMs: Date.now() - started, ...details }, [connection.apiKey]);
  try {
    const url = normalizeBaseUrl(connection.baseUrl) + endpoint;
    // Match the transport's idle timeout to the existing total request deadline.
    // Native fetch otherwise aborts a quiet long scrape after its default body timeout.
    if (!requestDispatchers.has(timeout)) requestDispatchers.set(timeout, new Agent({ headersTimeout: timeout, bodyTimeout: timeout }));
    log('ai.request', { url, method: body ? 'POST' : 'GET', timeoutMs: timeout, body });
    response = await withinDeadline(fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
      dispatcher: requestDispatchers.get(timeout),
      headers: { Authorization: 'Bearer ' + apiKey(connection.apiKey), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    log('ai.response.headers', { httpStatus: response.status, headers: Object.fromEntries(
      ['content-type', 'x-request-id', 'request-id', 'retry-after', 'server', 'cf-ray'].map(name => [name, response.headers?.get(name)])) });
    if (!response.ok) {
      let diagnostic, raw;
      try {
        const chunks = []; let size = 0;
        reader = response.body.getReader();
        while (true) {
          const { value: chunk, done } = await read();
          if (done) break;
          size += chunk.byteLength;
          if (size > 16384) break;
          chunks.push(Buffer.from(chunk));
        }
        if (size <= 16384) {
          raw = Buffer.concat(chunks).toString('utf8');
          try { diagnostic = JSON.parse(raw); } catch { /* Debug mode records a bounded, redacted non-JSON body. */ }
        }
      } catch { /* Preserve HTTP diagnostics when the error body is unreadable. */ }
      log('ai.response.error', { httpStatus: response.status, body: diagnostic ?? raw ?? '[UNAVAILABLE_OR_OVERSIZED]' });
      if (endpoint === '/responses') {
        searchFailure('AI 服务返回 HTTP ' + response.status + '，联网搜索需要当前接口和模型支持 Responses API 与原生 web_search', diagnostic, connection,
          { httpStatus: response.status, requestId: response.headers?.get('x-request-id') });
      }
      fail('AI 服务返回 HTTP ' + response.status + '，请检查密钥、模型、思考程度及接口权限', 502);
    }
    if (endpoint === '/responses' && response.headers?.get('content-type')?.includes('text/event-stream')) {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '', size = 0, completed;
      const eventCounts = Object.create(null);
      const consume = event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(data); }
        catch (error) { log('ai.response.invalid_event', { data }); throw error; }
        eventCounts[parsed.type] = (eventCounts[parsed.type] || 0) + 1;
        // Deltas are represented by their counts and assembled output, avoiding a log line per token.
        if (!parsed.type?.endsWith('.delta')) log('ai.response.event', { event: parsed });
        if (['response.failed', 'response.incomplete', 'error'].includes(parsed.type)) searchFailure('联网搜索未完成', parsed, connection);
        if (parsed.type === 'response.completed') {
          if (!parsed.response || typeof parsed.response !== 'object' || Array.isArray(parsed.response)) {
            searchFailure('联网搜索完成事件缺少最终响应', parsed, connection);
          }
          completed = parsed.response;
          return true;
        }
      };
      try {
        while (true) {
          const { value: chunk, done } = await read();
          if (done) break;
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) fail('联网搜索响应超过大小上限', 502);
          text += decoder.decode(chunk, { stream: true });
          const events = text.split(/\r?\n\r?\n/); text = events.pop();
          // response.completed contains the complete final output, including
          // messages and tool evidence. Do not wait for EOF or consume trailers.
          for (const event of events) if (consume(event)) return completed;
        }
        text += decoder.decode();
        if (text.trim()) consume(text);
      } finally {
        log('ai.response.stream', { receivedBytes: size, eventCounts, completed: !!completed });
      }
      if (!completed) searchFailure('联网搜索流式响应中断，未收到 response.completed', null, connection,
        { requestId: response.headers?.get('x-request-id'), receivedBytes: size });
      return completed;
    }
    if (!debug.isEnabled()) return await withinDeadline(response.json());
    const raw = await withinDeadline(response.text());
    let result;
    try { result = JSON.parse(raw); }
    catch (error) { log('ai.response.invalid', { body: raw }); throw error; }
    log('ai.response.body', { body: result });
    return result;
  } catch (error) {
    log('ai.request.failed', { error });
    if (error.status) throw error;
    if (endpoint === '/responses') searchFailure('联网搜索连接失败、超时或响应无效', null, connection,
      { errorType: error.name, code: error.cause?.code || error.code, timeoutMs: timeout });
    fail('AI 连接失败、超时或未返回 JSON，请检查接口地址与网络', 502);
  } finally {
    clearTimeout(timer);
    // Avoid async-iterator return(), which waits for cancellation. A provider's
    // hanging cancel must never hold a successful response or an AI queue slot.
    controller.abort();
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best-effort transport cleanup. */ }
      try { reader.releaseLock(); } catch { /* A pending transport read may still own the lock. */ }
    }
  }
}

async function listModels(connection, { refresh = false } = {}) {
  const baseUrl = normalizeBaseUrl(connection.baseUrl);
  const key = apiKey(connection.apiKey);
  if (!key) fail('请先填写 AI API Key');
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([baseUrl, key])).digest('hex');
  const cached = catalogs.get(cacheKey);
  if (!refresh && cached?.expires > Date.now()) return structuredClone(cached.result);
  const json = await request({ baseUrl, apiKey: key }, '/models');
  if (!Array.isArray(json?.data)) fail('接口没有返回有效的模型列表，请检查是否为 OpenAI 兼容 API 地址', 502);
  const ids = new Set();
  const models = json.data.filter(model => {
    if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 200 || ids.has(model.id)) return false;
    if (/(?:embedding|whisper|tts|dall-e|image|moderation|realtime|transcribe)/i.test(model.id)) return false;
    const endpoints = model.supported_endpoint_types;
    if (Array.isArray(endpoints) && !endpoints.some(type => ['openai', 'chat_completions', 'chat/completions'].includes(type))) return false;
    ids.add(model.id); return true;
  }).map(model => ({ id: model.id, reasoning: reasoning(model) })).sort((a, b) => a.id.localeCompare(b.id));
  const result = { baseUrl, models };
  if (catalogs.size >= 100) catalogs.delete(catalogs.keys().next().value);
  catalogs.set(cacheKey, { expires: Date.now() + 300000, result });
  return structuredClone(result);
}

async function validateSelection(connection, model, effort = '') {
  const catalog = await listModels(connection);
  const selected = catalog.models.find(item => item.id === model);
  if (!selected) fail('所选模型不在当前接口的可用列表中，请重新获取并选择模型');
  // Empty effort remains valid for persisted configurations from before the four-level selector.
  if (effort !== '' && !selected.reasoning.options.some(option => option.value === effort && !option.disabled)) fail('所选模型不支持此思考程度，请重新选择');
  return selected;
}

async function complete({ messages, response_format }, options) {
  let settings = options && { ...options };
  if (!settings) {
    const config = require('./config');
    settings = { baseUrl: config.AI_BASE_URL, apiKey: config.AI_API_KEY, model: config.AI_MODEL, effort: config.AI_REASONING_EFFORT, concurrency: config.AI_MAX_CONCURRENCY };
  }
  if (!settings.apiKey || !settings.model) fail('请先配置 AI API Key 并选择模型');
  // Do not force temperature: several reasoning models reject it even at zero.
  const body = { model: settings.model, messages, ...(response_format ? { response_format } : {}), ...(settings.effort ? { reasoning_effort: settings.effort } : {}) };
  const key = crypto.createHash('sha256').update(JSON.stringify([normalizeBaseUrl(settings.baseUrl), apiKey(settings.apiKey), body, settings.timeout ?? 120000])).digest('hex');
  if (!inFlight.has(key)) {
    const pending = limited(async () => {
      const result = await request(settings, '/chat/completions', body, settings.timeout ?? 120000);
      if (typeof result?.choices?.[0]?.message?.content !== 'string' || !result.choices[0].message.content.trim()) fail('AI 未返回有效的文本结果', 502);
      return result;
    }, settings.concurrency, key).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
  }
  promotePending(key);
  return structuredClone(await inFlight.get(key));
}

function citationUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

// Like spotify-helper, verify actual provider tool output, never the model's claim that it searched.
// https://developers.openai.com/api/docs/guides/tools-web-search
async function webSearch({ messages, allowUnverifiedResult = false }, options) {
  const config = require('./config');
  // Capture eligibility when called, not when another request releases a slot.
  if (!options && !config.AI_WEB_SEARCH_ENABLED) return { text: '', sources: [], searchCalls: 0,
    searchCallDetails: [], toolSources: [], annotations: [], responseId: '' };
  const settings = options ? { ...options } : { baseUrl: config.AI_BASE_URL, apiKey: config.AI_API_KEY, model: config.AI_MODEL,
    effort: config.AI_REASONING_EFFORT, concurrency: config.AI_MAX_CONCURRENCY };
  if (!settings.apiKey || !settings.model) fail('请先配置 AI API Key 并选择模型');
  const body = { model: settings.model, input: messages, store: false, stream: true,
    tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'],
    ...(settings.effort ? { reasoning: { effort: settings.effort } } : {}) };
  const key = crypto.createHash('sha256').update(JSON.stringify(['web-search', normalizeBaseUrl(settings.baseUrl), apiKey(settings.apiKey), body, settings.timeout ?? 120000, allowUnverifiedResult === true])).digest('hex');
  if (!inFlight.has(key)) {
    const pending = limited(async () => {
      const result = await request(settings, '/responses', body, settings.timeout ?? 120000);
      if (result?.status !== 'completed' || result.error || !Array.isArray(result.output)) searchFailure('联网搜索未返回完整的 Responses 结果', result, settings);
      const searchCallDetails = result.output.filter(item => item?.type === 'web_search_call');
      const completedCalls = searchCallDetails.filter(item => item.status === 'completed');
      const searches = completedCalls.filter(item => item.action?.type === 'search');
      const content = result.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).filter(item => item.type === 'output_text');
      const text = content.map(item => item.text || '').join('\n').trim();
      // Scraping trusts the final AI text. Only the explicit connection probe
      // and legacy callers require observable search/source evidence.
      if (!searches.length && !allowUnverifiedResult) searchFailure('接口已返回结果，但没有真实完成的 web_search 搜索调用；普通回答或文本中的工具调用不算联网成功，可开启调试模式查看响应', result, settings);
      const sources = new Map();
      const toolSources = completedCalls.flatMap(item => [
        ...(Array.isArray(item.action?.sources) ? item.action.sources : []),
        ...(['open_page', 'find_in_page'].includes(item.action?.type) && item.action.url ? [{ url: item.action.url }] : []),
      ].map(source => ({ ...source, callId: item.id || '', actionType: item.action?.type || '' })));
      const annotations = content.flatMap(item => item.annotations || []);
      const candidates = [...toolSources, ...annotations.filter(item => item.type === 'url_citation')];
      for (const source of candidates) {
        const url = citationUrl(source.url);
        if (url) sources.set(url, { url, title: typeof source.title === 'string' ? source.title.slice(0, 300) : new URL(url).hostname });
      }
      if (!text || (!sources.size && !allowUnverifiedResult)) searchFailure('已执行 web_search，但未返回可核对的文本与来源链接', result, settings,
        { textLength: text.length, sourceCount: sources.size });
      debug.log(allowUnverifiedResult ? 'ai.scrape.returned' : 'ai.search.verified',
        { responseId: result.id, searchCalls: searches.length, sources: [...sources.values()], text }, [settings.apiKey]);
      return { text, sources: [...sources.values()], searchCalls: searches.length,
        searchCallDetails, toolSources, annotations, responseId: result.id || '' };
    }, settings.concurrency, key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  promotePending(key);
  return structuredClone(await inFlight.get(key));
}

async function testWebSearch(options) {
  const result = await webSearch({ messages: [{ role: 'user', content: '请用 web_search 联网搜索 Bangumi 番组计划的官方网站，简短回复官方名称和主页链接，必须引用实际搜索结果。' }] }, options);
  if (!result.sources.some(source => ['bangumi.tv', 'bgm.tv', 'chii.in'].includes(new URL(source.url).hostname))) fail('已执行 web_search，但未返回测试所需的 Bangumi 官方来源', 502);
  return { success: true, message: '联网搜索成功，已验证真实搜索调用与 Bangumi 官方来源', searchCalls: result.searchCalls, sources: result.sources };
}

module.exports = { EFFORTS, normalizeBaseUrl, apiKey, connection, reasoning, listModels, validateSelection, complete, webSearch, testWebSearch, citationUrl, setConcurrency, withPriority };
