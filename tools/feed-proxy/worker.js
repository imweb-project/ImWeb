// ImWeb feed proxy — a Cloudflare Worker that fetches allowlisted RSS/Atom
// feeds for the Teletext source (P150) and returns them with CORS headers.
//
//   GET /?url=<encoded feed URL>
//
// Only GET. Only hosts in ALLOWED_HOSTS (redirects are followed by hand and
// re-checked, so an allowlisted host cannot bounce the Worker elsewhere).
// No key, no secret: the allowlist is what keeps this from being an open proxy.

const ALLOWED_HOSTS = new Set([
  'feeds.bbci.co.uk',
  'www.ruv.is',
  'yle.fi',
  'www.aljazeera.com',
  'www.theguardian.com',
  'www.dezeen.com',
  'hyperallergic.com',
  'www.creativeapplications.net',
  'earthsky.org',
  'spaceweatherarchive.com',
  'auroraforecast.is',
]);

const ALLOWED_ORIGINS = new Set([
  'https://imweb.image-ine.org',
  'http://localhost:5173',
  'http://localhost:4173',
]);

const CACHE_SECONDS = 300;
const MAX_REDIRECTS = 3;

function allowedTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return ALLOWED_HOSTS.has(u.hostname) ? u : null;
}

function corsHeaders(request) {
  const h = new Headers({ 'Vary': 'Origin' });
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

function refuse(request, msg) {
  const h = corsHeaders(request);
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(msg + '\n', { status: 403, headers: h });
}

async function fetchFeed(target) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.href, {
      redirect: 'manual',
      headers: { 'User-Agent': 'ImWeb-feed-proxy (+https://imweb.image-ine.org)' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (res.status < 300 || res.status >= 400) return res;
    const next = allowedTarget(new URL(res.headers.get('Location') || '', url).href);
    if (!next) return null;
    url = next;
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') return refuse(request, 'GET only');

    const target = allowedTarget(new URL(request.url).searchParams.get('url') || '');
    if (!target) return refuse(request, 'host not allowed');

    // Edge cache keyed on the feed URL alone, so every origin shares one copy.
    const cache = caches.default;
    const cacheKey = new Request('https://feed-proxy.cache/' + encodeURIComponent(target.href));
    let upstream = await cache.match(cacheKey);
    if (!upstream) {
      let res;
      try { res = await fetchFeed(target); } catch {
        return new Response('upstream fetch failed\n', { status: 502, headers: corsHeaders(request) });
      }
      if (!res) return refuse(request, 'redirect to a host not allowed');
      upstream = new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/xml; charset=utf-8',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        },
      });
      if (res.ok) ctx.waitUntil(cache.put(cacheKey, upstream.clone()));
    }

    const h = corsHeaders(request);
    h.set('Content-Type', upstream.headers.get('Content-Type'));
    h.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    return new Response(upstream.body, { status: upstream.status, headers: h });
  },
};
