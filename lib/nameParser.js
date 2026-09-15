const path = require('path');
const { normalizeText, unique } = require('./utils');

const STATUS_WORDS = ['完结', '完', '未完', '连载', '电子版', '掃圖', '扫图'];
const NOISE_WORDS = ['汉化组', '漢化組', '汉化', '漢化', '自购', '自購', '一般コミック'];
const PUBLISHER_WORDS = [
  '东立',
  '東立',
  '尖端',
  '台灣角川',
  '台湾角川',
  '角川',
  '講談社',
  '讲谈社',
  '集英社',
  '小学館',
  '小學館',
  'スクウェア',
  'Square Enix',
];

const CHINESE_NUMERAL = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseToNumber(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\s*\.\s*/g, '.').trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (!/[零〇一二两兩三四五六七八九十百]/.test(normalized)) return null;
  let total = 0;
  let current = 0;
  for (const ch of normalized) {
    if (ch === '十') {
      current = current || 1;
      total += current * 10;
      current = 0;
    } else if (ch === '百') {
      current = current || 1;
      total += current * 100;
      current = 0;
    } else if (Object.prototype.hasOwnProperty.call(CHINESE_NUMERAL, ch)) {
      current = CHINESE_NUMERAL[ch];
    }
  }
  return total + current || null;
}

function cleanExt(name) {
  const value = String(name || '').trim();
  const ext = path.extname(value).toLowerCase();
  if (/^\.(zip|cbz|rar|pdf|epub|7z|jpg|jpeg|png|webp|gif|bmp|avif)$/.test(ext)) {
    return path.basename(value, ext).trim();
  }
  return path.basename(value).trim();
}

function bracketParts(name) {
  const matches = [];
  const re = /[\[【［](.*?)[\]】］]/g;
  let match;
  while ((match = re.exec(name)) !== null) {
    const text = match[1].trim();
    if (text) matches.push(text);
  }
  return matches;
}

function parseRange(text, kind) {
  const number = '([0-9]+(?:\\s*\\.\\s*[0-9]+)?|[零〇一二两兩三四五六七八九十百]+)';
  const patterns = kind === 'chapter'
    ? [
        new RegExp(`(?:chap(?:ter)?|ch)\\.?\\s*${number}(?:\\s*(?:话|話|章))?(?:\\s*[-~～至到]\\s*(?:(?:chap(?:ter)?|ch)\\.?)?\\s*${number}(?:\\s*(?:话|話|章))?)?`, 'i'),
        new RegExp(`第\\s*${number}\\s*(?:话|話|章)(?:\\s*[-~～至到]\\s*(?:第\\s*)?${number}\\s*(?:话|話|章)?)?`, 'i'),
        new RegExp(`${number}\\s*(?:话|話|章)(?:\\s*[-~～至到]\\s*${number}\\s*(?:话|話|章)?)?`, 'i'),
      ]
    : [
        new RegExp(`(?:vol(?:ume)?|卷|冊|册)\\.?\\s*${number}(?:\\s*(?:卷|冊|册))?(?:\\s*[-~～至到]\\s*(?:(?:vol(?:ume)?|卷|冊|册)\\.?)?\\s*${number}(?:\\s*(?:卷|冊|册))?)?`, 'i'),
        new RegExp(`第\\s*${number}\\s*(?:卷|冊|册)(?:\\s*[-~～至到]\\s*(?:第\\s*)?${number}\\s*(?:卷|冊|册)?)?`, 'i'),
        new RegExp(`${number}\\s*(?:卷|冊|册)(?:\\s*[-~～至到]\\s*${number}\\s*(?:卷|冊|册)?)?`, 'i'),
      ];
  const match = patterns.map(re => text.match(re)).find(Boolean);
  if (!match) return null;
  return {
    start: chineseToNumber(match[1]),
    end: chineseToNumber(match[2] || match[1]),
    raw: match[0],
  };
}

function parsePlainRange(text) {
  const parenthesized = text.match(/[（(〈<《]\s*(\d{1,3}(?:\s*\.\s*\d+)?)(?:\s*[-~～至到]\s*(\d{1,3}(?:\s*\.\s*\d+)?))?\s*[)）〉>》](?:\s*(?:完|未完))?$/) ||
    text.match(/(?:^|[\s\[\]【】_-])[（(〈<《]\s*(\d{1,3}(?:\s*\.\s*\d+)?)(?:\s*[-~～至到]\s*(\d{1,3}(?:\s*\.\s*\d+)?))?\s*[)）〉>》](?:\s*(?:完|未完))?(?:$|[\s\[\]【】_-])/);
  if (parenthesized) {
    return {
      start: chineseToNumber(parenthesized[1]),
      end: chineseToNumber(parenthesized[2] || parenthesized[1]),
      raw: parenthesized[0].trim(),
    };
  }

  const match = text.match(/(?:^|[\s\[\]【】_-])(\d{1,3}(?:\s*\.\s*\d+)?)(?:\s*[-~～至到]\s*(\d{1,3}(?:\s*\.\s*\d+)?))?(?:\s*(?:完|未完))?(?:$|[\s\[\]【】_-])/);
  if (!match) return null;
  return {
    start: chineseToNumber(match[1]),
    end: chineseToNumber(match[2] || match[1]),
    raw: match[0].trim(),
  };
}

function looksLikeResourceToken(text) {
  const value = String(text || '').trim();
  const normalized = normalizeText(value);
  return /vol|volume|chap|chapter/.test(normalized) ||
    /(?:^|\D)第?[零〇一二两兩三四五六七八九十百0-9]+(?:\s*[-~～至到]\s*[零〇一二两兩三四五六七八九十百0-9]+)?\s*(?:卷|冊|册|话|話|章)(?:$|\D)/.test(value) ||
    /^\d+(?:\s*[-~～至到]\s*\d+)?(?:完|未完)?$/.test(value);
}

function looksLikeStatusOrNoise(text) {
  const value = String(text || '');
  return STATUS_WORDS.some(w => value.includes(w)) ||
    NOISE_WORDS.some(w => value.includes(w));
}

function looksLikePublisher(text) {
  const normalized = normalizeText(text);
  return PUBLISHER_WORDS.some(word => normalized.includes(normalizeText(word)));
}

function looksLikeTitleToken(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /[的之]/.test(value) ||
    /の/.test(value) ||
    /(?:憂鬱|忧郁|物語|物语|日記|日记|少女|少年|先生|大人|さん|ちゃん|くん)/.test(value);
}

function looksLikeCreatorToken(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (looksLikeTitleToken(value)) return false;
  const normalized = normalizeText(value);
  if (!normalized || normalized.length > 14) return false;
  return /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー・\s]+$/u.test(value);
}

function removeResourceTokens(text) {
  return String(text || '')
    .replace(/[\[【［][^\]】］]*(?:vol(?:ume)?|chap(?:ter)?|第|卷|冊|册|话|話|\d+(?:\.\d+)?\s*[-~～至到]\s*\d+(?:\.\d+)?)[^\]】］]*[\]】］]/gi, ' ')
    .replace(/(?:vol(?:ume)?|chap(?:ter)?|ch)\.?\s*\d+(?:\.\d+)?(?:\s*[-~～至到]\s*(?:vol(?:ume)?|chap(?:ter)?|ch)?\.?\s*\d+(?:\.\d+)?)?/gi, ' ')
    .replace(/[第]?[零〇一二两兩三四五六七八九十百0-9]+(?:\s*[-~～至到]\s*[零〇一二两兩三四五六七八九十百0-9]+)?\s*(?:卷|冊|册|话|話|章)/g, ' ')
    .replace(/[（(〈<《]\s*\d{1,3}(?:\.\d+)?(?:\s*[-~～至到]\s*\d{1,3}(?:\.\d+)?)?\s*[)）〉>》](?:\s*(?:完|未完))?/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*[-~～至到]\s*\d+(?:\.\d+)?\s*(?:完|未完)?/g, ' ')
    .replace(/(?:^|[\s\[\]【】_-])\d{1,3}(?:\.\d+)?(?:\s*(?:完|未完))?$/g, ' ')
    .replace(/\s+[-_]\s+$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function splitAuthorToken(token) {
  if (!token) return [];
  return unique(
    String(token)
      .split(/[×xX＊*／/＆&、,，]+/)
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function parseName(inputName) {
  const base = cleanExt(inputName);
  const parts = bracketParts(base);
  const volumeRange = parseRange(base, 'volume');
  const chapterRange = parseRange(base, 'chapter');
  const plainRange = !volumeRange && !chapterRange ? parsePlainRange(base) : null;

  const status = base.includes('未完')
    ? '未完'
    : (/(?:完结|完結)|(?:^|[^\u4e00-\u9fff])完(?:$|[^\u4e00-\u9fff])|完$/.test(base) ? '完结' : '');

  const publishers = unique(parts.filter(looksLikePublisher));
  const extraTags = unique(parts.filter(p => looksLikeStatusOrNoise(p) || looksLikePublisher(p)));

  let title = '';
  let authors = [];
  const titleAuthorCandidates = [];
  if (parts.length > 0) {
    const meaningful = parts.filter(p =>
      !looksLikeResourceToken(p) &&
      !looksLikeStatusOrNoise(p) &&
      !looksLikePublisher(p)
    );
    if (meaningful.length >= 2) {
      titleAuthorCandidates.push(
        { title: meaningful[0], authors: splitAuthorToken(meaningful[1]) },
        { title: meaningful[1], authors: splitAuthorToken(meaningful[0]) }
      );
    }
    if (
      meaningful.length >= 2 &&
      looksLikeCreatorToken(meaningful[0]) &&
      looksLikeTitleToken(meaningful[1])
    ) {
      title = meaningful[1];
      authors = splitAuthorToken(meaningful[0]);
    } else {
      title = meaningful[0] || parts.find(p => !looksLikeResourceToken(p)) || base;
      if (meaningful[1]) authors = splitAuthorToken(meaningful[1]);
    }
  } else {
    title = removeResourceTokens(base)
      .replace(/\s*[-_]\s*$/g, '')
      .trim();
    if (!title) title = base;
  }

  title = title.replace(/^[\s\-_]+|[\s\-_]+$/g, '').trim() || base;

  const hasVolume = !!volumeRange || (!!plainRange && !chapterRange);
  const hasChapter = !!chapterRange;
  const hasMixed = !!volumeRange && !!chapterRange && volumeRange.end !== volumeRange.start;
  const detectedRange = volumeRange || chapterRange || plainRange;
  const detectedNumber = detectedRange ? detectedRange.start : null;
  const detectedNumberEnd = detectedRange ? detectedRange.end : null;
  const detectedNumberType = hasVolume ? 'volume' : (hasChapter ? 'chapter' : '');

  return {
    originalName: inputName,
    title,
    titleNormalized: normalizeText(title),
    alternateTitles: unique([base, title].filter(v => v !== title)),
    authors,
    publishers,
    status,
    tags: extraTags,
    volumeRange,
    chapterRange,
    detectedNumber,
    detectedNumberEnd,
    detectedNumberType,
    contentType: hasMixed ? 'mixed_bundle' : (hasVolume ? 'volume' : (hasChapter ? 'chapter' : 'chapter')),
    parseHints: {
      bracketParts: parts,
      plainRange,
      titleAuthorCandidates: titleAuthorCandidates
        .filter(item => item.title && item.authors.length > 0),
    },
  };
}

module.exports = {
  chineseToNumber,
  parseName,
};
