'use strict';
// Deploy behind HTTPS. The Brave key stays on this service, never in the app.
const http = require('node:http');
const crypto = require('node:crypto');
const key = process.env.BRAVE_SEARCH_API_KEY;
const secret = process.env.ATLAS_SESSION_SECRET;
if (!key || !secret || secret.length < 32) throw new Error('Set BRAVE_SEARCH_API_KEY and a random ATLAS_SESSION_SECRET of at least 32 characters.');
const quotas = new Map();
function limit(name, maximum, duration) {
  const now = Date.now();
  let item = quotas.get(name);
  if (!item || item.until < now) { item = { count: 0, until: now + duration }; quotas.set(name, item); }
  if (++item.count > maximum) throw Object.assign(new Error('Usage limit reached. Try again later.'), { status: 429 });
}
setInterval(() => { for (const [name, item] of quotas) if (item.until < Date.now()) quotas.delete(name); }, 60000).unref();
const sign = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
function issue() {
  const expires = Date.now() + 30 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ id: crypto.randomUUID(), expires })).toString('base64url');
  return { token: payload + '.' + sign(payload), expires };
}
function authenticate(value) {
  const token = String(value || '').replace(/^Bearer /, '');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || token.length > 1000) throw Object.assign(new Error('Invalid session.'), { status: 401 });
  const a = Buffer.from(signature), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Invalid session.'), { status: 401 });
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  if (data.expires < Date.now()) throw Object.assign(new Error('Session expired.'), { status: 401 });
  return data.id;
}
async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 2048) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  return JSON.parse(text);
}
const server = http.createServer(async (request, response) => {
  const send = (status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(data));
  };
  try {
    const ip = process.env.ATLAS_TRUST_PROXY === '1'
      ? String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim()
      : request.socket.remoteAddress;
    if (request.url === '/health' && request.method === 'GET') return send(200, { ok: true });
    limit('requests:' + ip, 120, 60000);
    if (request.url === '/v1/session' && request.method === 'POST') {
      limit('sessions:' + ip, 8, 3600000); return send(200, issue());
    }
    if (request.url !== '/v1/search' || request.method !== 'POST') return send(404, { error: 'Not found.' });
    const id = authenticate(request.headers.authorization);
    limit('session:' + id, 20, 1800000);
    limit('search:' + ip, 60, 3600000);
    limit('global', Number(process.env.ATLAS_SEARCH_HOURLY_LIMIT) || 300, 3600000);
    const input = await body(request);
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 600) return send(400, { error: 'Use a short search query.' });
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', input.query); url.searchParams.set('count', '5'); url.searchParams.set('extra_snippets', 'true');
    const upstream = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return send(502, { error: 'Search provider unavailable.' });
    const data = await upstream.json();
    const results = (data.web?.results || []).slice(0, 5).filter(r => /^https:\/\//.test(r.url)).map(r => ({
      title: String(r.title || '').slice(0, 180), url: String(r.url).slice(0, 2048),
      excerpt: [r.description || '', ...(r.extra_snippets || [])].join('\n').slice(0, 2400)
    }));
    send(200, { results });
  } catch (error) {
    send(error.status || 400, { error: error.status ? error.message : 'Research request could not be completed.' });
  }
});
server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 50;
server.listen(Number(process.env.PORT) || 8787, process.env.HOST || '127.0.0.1', () => {
  console.log('Atlas research service is ready.');
});
