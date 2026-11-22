'use strict';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
const htmlEntities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return htmlEntities[entity.toLowerCase()];
    const hex = entity[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
  });
}

function plain(html, limit) {
  return decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function resultUrl(href) {
  try {
    let url = new URL(decode(href), ENDPOINT);
    if (['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/') {
      url = new URL(url.searchParams.get('uddg') || '');
    }
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) return url.href;
  } catch {}
  return '';
}

function parseSearchPage(html) {
  if (/anomaly-modal|id=["']challenge-form/.test(html)) throw new Error('The search provider temporarily blocked the request.');
  const results = new Map();
  const anchors = /<a\b([^>]*\bclass=["'][^"']*\bresult__(a|snippet)\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const [, attributes, kind, contents] of html.matchAll(anchors)) {
    const href = attributes.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const url = href && resultUrl(href);
    if (!url) continue;
    if (kind === 'a' && !results.has(url)) {
      if (results.size === 5) break;
      const title = plain(contents, 180);
      if (title) results.set(url, { title, url, excerpt: '' });
    } else if (kind === 'snippet' && results.has(url)) {
      results.get(url).excerpt = plain(contents, 500);
    }
  }
  if (!results.size && !/no-results|no results found/i.test(html)) {
    throw new Error('The search provider returned an unexpected response.');
  }
  return [...results.values()];
}

function searchQuery(value) {
  if (typeof value !== 'string') throw new Error('Enter a web search query.');
  const query = [...value.replace(/\s+/g, ' ').trim()].slice(0, 450).join('');
  if (!query) throw new Error('Enter a web search query.');
  return query;
}

async function searchWeb(value, signal, fetchImpl = fetch) {
  const query = searchQuery(value);
  const response = await fetchImpl(ENDPOINT + '?' + new URLSearchParams({ q: query }), {
    headers: { Accept: 'text/html' },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)])
  });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/html')) {
    throw new Error('The search provider is temporarily unavailable.');
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 512 * 1024) throw new Error('The search response was too large.');
    html += decoder.decode(chunk, { stream: true });
  }
  return parseSearchPage(html + decoder.decode());
}

module.exports = { searchWeb, parseSearchPage, searchQuery };
