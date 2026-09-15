// Synthetic provider-native search results; no live service or search site is contacted.
function researchFetch(names, observe = () => {}) {
  return async (url, options = {}) => {
    const request = JSON.parse(options.body || '{}');
    observe(request);
    if (new URL(url).pathname.endsWith('/responses')) {
      const entries = JSON.parse(request.input.at(-1).content).entries;
      const sources = names.map((item, index) => ({ url: 'https://www.wikidata.org/wiki/Q' + (index + 1), title: item.nameCn }));
      const results = entries.flatMap(entry => {
        const index = names.findIndex(item => item.sourceName === entry.sourceName);
        return index < 0 ? [] : [{ key: entry.key, nameCn: names[index].nameCn, confidence: 95,
          sources: [{ url: sources[index].url, excerpt: names[index].sourceName + '：' + names[index].nameCn }] }];
      });
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: sources.length ? sources : [{ url: 'https://example.org/no-match' }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ results }), annotations: [] }] },
      ] }) };
    }
    let input;
    try { input = JSON.parse(request.messages.at(-1).content); } catch {}
    const content = input?.entries ? JSON.stringify({ results: input.entries.flatMap(entry => {
      const name = names.find(item => item.sourceName === entry.sourceName);
      return name ? [{ key: entry.key, nameCn: name.nameCn }] : [];
    }) }) : '这是中文译文';
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}
module.exports = { researchFetch };
