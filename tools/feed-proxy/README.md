# ImWeb feed proxy (Cloudflare Worker)

Teletext page P150 reads RSS feeds in the browser. Some sites (NASA, NYT,
Wired, Open Culture, Pitchfork, USGS) send CORS headers and are read
directly. The rest — BBC, RÚV, Yle, Al Jazeera, the Guardian, Dezeen,
Hyperallergic, CreativeApplications — don't, so the browser needs a proxy.
This Worker is that proxy. It holds no key and no secret.

What it does:

- `GET /?url=<encoded feed URL>` fetches the feed and returns it with
  `Access-Control-Allow-Origin` set to the calling ImWeb origin
  (`https://imweb.image-ine.org`, `http://localhost:5173`,
  `http://localhost:4173`). Other origins get the body with no CORS header,
  so their browsers refuse it.
- Only hosts in `ALLOWED_HOSTS` (top of `worker.js`) are fetched. Redirects
  are followed by hand and each hop is re-checked against the list.
- Anything else — a non-GET request, a missing `url`, a host not on the list —
  gets `403`.
- Responses are cached for 5 minutes (`CACHE_SECONDS`).

## Deploy

You need a free Cloudflare account. From this folder:

```bash
cd tools/feed-proxy
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

`deploy` prints the Worker's address, something like
`https://imweb-feed-proxy.<your-subdomain>.workers.dev`. Check it:

```bash
curl -si -H 'Origin: http://localhost:5173' 'https://imweb-feed-proxy.<your-subdomain>.workers.dev/?url=https%3A%2F%2Ffeeds.bbci.co.uk%2Fnews%2Frss.xml' | head -20
```

You should see `200`, `Access-Control-Allow-Origin: http://localhost:5173`
and the start of the RSS XML.

To try it locally before deploying, `npx wrangler dev` serves it at
`http://localhost:8787/?url=…`.

## Use it in ImWeb

Teletext panel → **Proxy** field, enter:

```
https://imweb-feed-proxy.<your-subdomain>.workers.dev/?url={url}
```

ImWeb replaces `{url}` with the encoded feed address. The setting is stored
per browser (localStorage `imweb-teletext-proxy`), so enter it once on each
machine and each origin (5173, 4173 and the live site are separate).

## Changing it

- **Add a feed site:** add its exact hostname to `ALLOWED_HOSTS` and
  `npx wrangler deploy` again. `www.example.com` and `example.com` are
  different entries.
- **Serve ImWeb from a new address:** add the origin to `ALLOWED_ORIGINS`.
- The free plan allows 100,000 requests a day; with the 5-minute cache a
  Teletext session costs a handful.
