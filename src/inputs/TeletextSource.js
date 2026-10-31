// TeletextSource — Canvas 2D Teletext engine.
// Produces a THREE.CanvasTexture that AnalogTV.js accepts as its source texture.
// Uses a dirty-flag repaint model: canvas only redraws when page changes or clock ticks.
// Never touches Pipeline.addPass() — it is a standalone texture producer like TextLayer.

import * as THREE from 'three';
import { CANVAS_W, CANVAS_H, drawHeader, ttRow, ttRule } from './teletext_draw.js';
import { renderP100 } from './teletext_pages/P100_index.js';
import { renderP900 } from './teletext_pages/P900_system.js';
import { renderP400 } from './teletext_pages/P400_weather.js';
import { renderP401 } from './teletext_pages/P401_forecast.js';
import { renderP150 } from './teletext_pages/P150_headlines.js';
import { renderP500, parseICal } from './teletext_pages/P500_calendar.js';
import { renderP700 } from './teletext_pages/P700_nowplaying.js';
import { renderArticle } from './teletext_pages/P150_article.js';

// ── Page registry ─────────────────────────────────────────────────────────────
// Render functions are added here as each build step lands.
// A null renderer shows a "coming soon" placeholder.

const PAGE_IDS = ['P100', 'P150', 'P400', 'P401', 'P500', 'P700', 'P900'];

const PAGE_TITLES = {
  P100: 'IMWEB TELETEXT',
  P150: 'HEADLINES',
  P400: 'WEATHER TODAY',
  P401: 'HOURLY FORECAST',
  P500: 'CALENDAR',
  P700: 'NOW PLAYING',
  P900: 'SYSTEM INFO',
};

const PAGE_RENDERERS = {
  P100: renderP100,
  P150: renderP150,
  P400: renderP400,
  P401: renderP401,
  P500: renderP500,
  P700: renderP700,
  P900: renderP900,
};

const DATA_KEYS = {
  P150: 'rss',
  P400: 'weather',
  P401: 'weather',
  P500: 'calendar',
  P700: 'movie',
};

// Fetched as soon as Teletext is the source, whatever page is showing, so
// flipping to P150/P400 finds data waiting instead of "FETCHING…".
const PREFETCH_KEYS = ['rss', 'weather'];

// Works without a proxy: NASA sends Access-Control-Allow-Origin: *.
export const DEFAULT_RSS_URL = 'https://www.nasa.gov/feed/';
export const PROXY_KEY = 'imweb-teletext-proxy';
export const PLACE_KEY = 'imweb-teletext-place';

/**
 * Fetch text from a feed the browser may not be allowed to read.
 *
 * DIRECT first: feeds that send CORS headers (NASA, NYT, Wired, USGS) need no
 * third party at all. Only when that fails is the request retried through a
 * proxy — and only one the user configured (localStorage PROXY_KEY, a URL
 * template containing {url}). There is no built-in proxy: corsproxy.io's
 * keyless URLs, hardcoded here until 2026-10, began answering 403
 * "keyless_legacy_url" for every request, which left P150 on "FETCHING…"
 * forever, everywhere. A key must not be baked into the bundle.
 */
export async function fetchText(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (direct) {
    const tpl = localStorage.getItem(PROXY_KEY)?.trim();
    if (!tpl) {
      // A CORS refusal surfaces as a bare TypeError — name it for the page.
      throw new Error(direct.name === 'TypeError' ? 'needs a proxy' : direct.message);
    }
    const proxied = tpl.includes('{url}')
      ? tpl.replace('{url}', encodeURIComponent(url))
      : tpl + encodeURIComponent(url);
    const res = await fetch(proxied, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    return await res.text();
  }
}

/**
 * NOAA SWPC alerts.json → headline items. The headline is the bulletin's
 * "ALERT: / WARNING: / WATCH: / SUMMARY:" line; the description keeps the
 * validity window and NOAA scale lines. Newest first, as NOAA sends them.
 */
export function parseSwpcAlerts(alerts) {
  // Case-sensitive on purpose: headlines are upper case ("CONTINUED ALERT:",
  // "EXTENDED WARNING:"), and "Active Warning: YES" must not match.
  const HEAD = /^([A-Z]+ )?(ALERT|WARNING|WATCH|SUMMARY|CANCEL[A-Z]*)\b[^:]*:/;
  const KEEP = /^(Valid From|Valid To|Now Valid Until|Threshold Reached|Observed|NOAA Scale|Aurora -|[A-Z][a-z]{2} \d{2}:\s)/i;
  return (Array.isArray(alerts) ? alerts : []).slice(0, 40).map(a => {
    const lines = String(a.message ?? '').split(/\r?\n/)
      .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const head  = lines.find(l => HEAD.test(l)) ?? lines[0] ?? '';
    const when  = String(a.issue_datetime ?? '').slice(5, 16);   // "MM-DD HH:MM" UTC
    const seen  = new Set();
    const keep  = lines.filter(l => KEEP.test(l) && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
    return {
      title: (when ? when + 'Z ' : '') + head,
      link: 'https://www.swpc.noaa.gov/',
      description: keep.join(' · '),
    };
  }).filter(i => i.title);
}

// ── TeletextSource ────────────────────────────────────────────────────────────

export class TeletextSource {
  constructor() {
    this._canvas        = document.createElement('canvas');
    this._canvas.width  = CANVAS_W;
    this._canvas.height = CANVAS_H;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });

    this.texture = new THREE.CanvasTexture(this._canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    this._pageIdx = 0;
    this._dirty   = true; // force first paint

    this._subPageIdx   = 0;
    this._subPageCount = 1;
    this._cursorIdx    = 0;
    this._subPageTimer   = null;
    this._uiRefreshTimer = null;

    this._cachedData    = {};
    this._fetchInFlight = {};

    this._movieInput = null; // set via setMovieInput() from main.js

    this._readerMode    = false;
    this._readerItem    = null;   // { title, link, description, articleText, fetching, fetchFailed }
    this._readerSubPage = 0;
    this._articleFetchEnabled = true;

    // 1-second interval keeps the live clock (and later P900) ticking.
    // Cheap: sets a boolean only; actual canvas work happens in tick().
    this._clockTimer = setInterval(() => { this._dirty = true; }, 1000);
  }

  /**
   * Called from the main render loop when AnalogTV source === TELETEXT_SRC_IDX.
   * Handles page switches and dirty-flag repaints.
   */
  tick(ps, dt) {
    const pageIdx = ps.get('teletext.page')?.value ?? 0;
    if (pageIdx !== this._pageIdx) {
      this._pageIdx    = pageIdx;
      this._subPageIdx = 0;
      this._subPageCount = 1;
      this._cursorIdx  = 0;
      this._dirty      = true;
    }

    for (const k of PREFETCH_KEYS) {
      if (!this._cachedData[k] && !this._fetchInFlight[k]) this._dispatchFetch(k, ps);
    }

    // Poll data sources when on a data page
    const pageId = PAGE_IDS[this._pageIdx] ?? 'P100';
    const dk = DATA_KEYS[pageId];
    if (dk) {
      const pollMs = (ps.get('teletext.pollInterval')?.value ?? 300) * 1000;
      if (!this._cachedData[dk]) {
        // No data yet — fetch immediately (once)
        if (!this._fetchInFlight[dk]) this._dispatchFetch(dk, ps);
      } else {
        const stale = Date.now() - this._cachedData[dk].fetchedAt > pollMs;
        if (stale && !this._fetchInFlight[dk]) {
          this._dispatchFetch(dk, ps);
        }
      }
    }
    // P700 movie state is synchronous — update every tick when on P700
    if (pageId === 'P700' && this._movieInput) {
      const clip = this._movieInput.currentClip;
      this._cachedData.movie = {
        data: {
          filename: clip?.name ?? null,
          speed:    ps.get('movie.speed')?.value ?? 1.0,
          on:       ps.get('movie.active')?.value ?? 0,
        },
        fetchedAt: Date.now()
      };
      this._dirty = true;
    }
    if (this._dirty) {
      this._dirty = false;    // reset before render so any re-entrant set is preserved
      this._render();
      this.texture.needsUpdate = true;
    }
  }

  _render() {
    const ctx    = this._ctx;
    const pageId = PAGE_IDS[this._pageIdx] ?? 'P100';
    const render = PAGE_RENDERERS[pageId];

    // Clear to black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (this._readerMode && this._readerItem) {
      renderArticle(ctx, this._readerItem, this._readerSubPage);
      return;
    }

    if (render) {
      const dk = DATA_KEYS[pageId];
      const cached = this._cachedData[dk];
      const count = render(ctx, cached?.data, this._subPageIdx, this._cursorIdx);
      this.setSubPageCount(count ?? 1);
    } else {
      // Placeholder for pages not yet implemented
      const title = PAGE_TITLES[pageId] ?? pageId;
      drawHeader(ctx, pageId.replace('P', ''), title);
      ttRow(ctx, '', 2, '#000000');
      ttRow(ctx, `  ${pageId}  ${title}`, 3, '#666666');
      ttRow(ctx, '  Coming in a future build step.', 5, '#444444');
      ttRow(ctx, '  Return to P100 for the index.', 6, '#444444');
      ttRule(ctx, 8, '#222222');
    }
  }

  nextSubPage() {
    this._subPageIdx = (this._subPageIdx + 1) % this._subPageCount;
    this._cursorIdx = 0;
    this._dirty = true;
  }

  prevSubPage() {
    this._subPageIdx = (this._subPageIdx - 1 + this._subPageCount) % this._subPageCount;
    this._cursorIdx = 0;
    this._dirty = true;
  }

  setSubPageCount(n) {
    this._subPageCount = Math.max(1, n | 0);
    if (this._subPageIdx >= this._subPageCount) this._subPageIdx = 0;
  }

  moveCursor(delta) {
    const items    = this._cachedData.rss?.data?.items ?? [];
    const perPage  = 8;
    const pageItems = Math.min(perPage, items.length - this._subPageIdx * perPage);
    this._cursorIdx = Math.max(0, Math.min(pageItems - 1, this._cursorIdx + delta));
    this._dirty = true;
  }

  openItem(localIdx) {
    const items = this._cachedData.rss?.data?.items ?? [];
    const item  = items[this._subPageIdx * 8 + localIdx];
    if (!item) return;

    if (this._articleFetchEnabled) {
      this.enterReader({ ...item, articleText: null, fetching: true, fetchFailed: false });
      this._fetchArticle(item.link);
    } else {
      this.enterReader({ ...item, articleText: null, fetching: false, fetchFailed: false });
    }
  }

  openSelected() { this.openItem(this._cursorIdx); }

  enterReader(item) {
    this._readerMode    = true;
    this._readerItem    = item;
    this._readerSubPage = 0;
    this._dirty = true;
  }

  exitReader() {
    this._readerMode = false;
    this._readerItem = null;
    this._dirty = true;
  }

  readerNextPage() {
    this._readerSubPage++;
    this._dirty = true;
  }

  readerPrevPage() {
    if (this._readerSubPage > 0) this._readerSubPage--;
    else this.exitReader();
    this._dirty = true;
  }

  setArticleFetch(v) { this._articleFetchEnabled = !!v; }

  async _fetchArticle(url) {
    try {
      const html  = await fetchText(url);

      const doc   = new DOMParser().parseFromString(html, 'text/html');

      // Remove noise elements
      ['script','style','nav','header','footer','aside','figure','noscript']
        .forEach(tag => doc.querySelectorAll(tag).forEach(el => el.remove()));

      // Extract paragraphs — prefer <article>, then <main>, then body
      const container = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
      const paras = [...container.querySelectorAll('p')]
        .map(p => p.textContent.replace(/\s+/g, ' ').trim())
        .filter(t => t.length > 40);

      const articleText = paras.slice(0, 20).join(' \u00B6 ') || null;

      if (this._readerMode && this._readerItem) {
        this._readerItem = { ...this._readerItem, articleText, fetching: false, fetchFailed: !articleText };
        this._readerSubPage = 0;
        this._dirty = true;
      }
    } catch (e) {
      console.warn('[TeletextSource] Article fetch failed:', e.message);
      if (this._readerMode && this._readerItem) {
        this._readerItem = { ...this._readerItem, fetching: false, fetchFailed: true };
        this._dirty = true;
      }
    }
  }

  _dispatchFetch(dataKey, ps) {
    if (dataKey === 'weather') {
      this._fetchWeather(ps);
    } else if (dataKey === 'rss') {
      this._fetchRSS();
    } else if (dataKey === 'calendar') {
      this._fetchCalendar(ps);
    }
  }

  async _fetchWeather(ps) {
    this._fetchInFlight.weather = true;
    try {
      const lat = ps.get('teletext.latitude')?.value  ?? 64.1466;
      const lon = ps.get('teletext.longitude')?.value ?? -21.9426;
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat}&longitude=${lon}`
        + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m'
        + '&hourly=temperature_2m,weather_code,precipitation_probability'
        + '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
        + '&timezone=auto&forecast_days=6';

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Attach lat/lon (may differ from request due to Open-Meteo rounding)
      if (json.latitude == null)  json.latitude  = lat;
      if (json.longitude == null) json.longitude = lon;
      json._fetchedAt = Date.now();
      // The place name chosen by search — only while the coordinates are still
      // the ones it set. Lat/lon are captured by Display States and the name is
      // per-browser, so a State recalled with other coordinates shows numbers,
      // never the wrong city.
      try {
        const place = JSON.parse(localStorage.getItem(PLACE_KEY));
        if (place && Math.abs(place.lat - lat) < 1e-3 && Math.abs(place.lon - lon) < 1e-3) {
          json._place = place.name;
        }
      } catch { /* none stored */ }

      this._cachedData.weather = { data: json, fetchedAt: Date.now() };
      this._dirty = true;
    } catch (e) {
      console.warn('[TeletextSource] Weather fetch failed:', e.message);
    } finally {
      this._fetchInFlight.weather = false;
    }
  }

  async _fetchRSS(ps) {
    this._fetchInFlight.rss = true;
    const url = localStorage.getItem('imweb-teletext-rssUrl') || DEFAULT_RSS_URL;
    try {
      const xml = await fetchText(url);

      // NOAA SWPC alerts.json is the one non-XML preset: an array of
      // { issue_datetime, message } whose message is a plain-text bulletin.
      if (xml.trimStart().startsWith('[')) {
        const items = parseSwpcAlerts(JSON.parse(xml));
        this._cachedData.rss = {
          data: { items, feedTitle: 'NOAA SPACE WEATHER', fetchedAt: Date.now() },
          fetchedAt: Date.now(),
        };
        if (!items.length) throw new Error('no alerts in feed');
        this.setSubPageCount(Math.ceil(items.length / 8));
        this._dirty = true;
        return;
      }

      let doc = new DOMParser().parseFromString(xml, 'text/xml');
      // NASA Science feeds (2026-10) emit `…/apod/"xmlns:media=…` with no space
      // between attributes, and the strict parser rejects the whole document.
      // Only on a failed parse: put the missing space back and try once more.
      if (doc.querySelector('parsererror')) {
        doc = new DOMParser().parseFromString(
          xml.replace(/"(?=[A-Za-z_][\w.-]*(:[\w.-]+)?=")/g, '" '), 'text/xml');
      }

      // Support RSS 2.0 (<item>) and Atom (<entry>)
      const itemEls = [...doc.querySelectorAll('item, entry')];
      const items = itemEls.map(el => ({
        title: el.querySelector('title')?.textContent?.trim() ?? '',
        link:  (el.querySelector('link')?.textContent?.trim()
            || el.querySelector('link')?.getAttribute('href')) ?? '',
        description: (
          el.querySelector('description')?.textContent?.trim()
          || el.querySelector('summary')?.textContent?.trim()
          || ''
        ).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      })).filter(i => i.title);

      // Feed title: RSS 2.0 channel > title, or Atom feed > title
      const feedTitle = doc.querySelector('channel > title, feed > title')
                          ?.textContent?.trim() ?? 'RSS FEED';

      this._cachedData.rss = {
        data: { items, feedTitle, fetchedAt: Date.now() },
        fetchedAt: Date.now(),
      };
      if (!items.length) throw new Error('no items in feed');
      this.setSubPageCount(Math.ceil(items.length / 8));
      this._dirty = true;
    } catch (e) {
      console.warn('[TeletextSource] RSS fetch failed:', e.message);
      // Cache the failure so P150 can SAY it failed. With nothing cached the
      // page read "FETCHING…" forever; with this the poll interval retries.
      this._cachedData.rss = { data: { error: e.message, url }, fetchedAt: Date.now() };
      this._dirty = true;
    } finally {
      this._fetchInFlight.rss = false;
    }
  }

  /**
   * The P150 feed as plain headline strings, for the Text layer. P150 only
   * fetches while Teletext is being rendered, so this fetches itself when the
   * cache is missing, failed, or older than maxAgeMs.
   * Returns { feedTitle, titles, fetchedAt } or { error }.
   */
  async getHeadlines(maxAgeMs = Infinity) {
    const c = this._cachedData.rss;
    if (!c || c.data?.error || Date.now() - c.fetchedAt > maxAgeMs) {
      if (!this._fetchInFlight.rss) await this._fetchRSS();
      // A fetch the render loop already started: wait for it rather than
      // answering from an empty cache.
      for (let i = 0; i < 150 && this._fetchInFlight.rss; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const d = this._cachedData.rss?.data;
    if (!d?.items) return { error: d?.error ?? 'no feed yet' };
    return { feedTitle: d.feedTitle, titles: d.items.map(i => i.title), fetchedAt: d.fetchedAt };
  }

  fetchRSS(url) {
    localStorage.setItem('imweb-teletext-rssUrl', url);
    delete this._cachedData.rss;
    this._fetchInFlight.rss = false;
    this._dispatchFetch('rss');
  }

  async _fetchCalendar(ps) {
    const url = localStorage.getItem('imweb-teletext-ics-url');
    if (!url) {
      this._cachedData.calendar = null;
      this._dirty = true;
      return;
    }
    this._fetchInFlight.calendar = true;
    try {
      const text = await fetchText(url);
      const events = parseICal(text);
      if (events.length === 0) throw new Error('No VEVENT blocks found in .ics file');
      this._cachedData.calendar = {
        data: { events, feedTitle: null },
        fetchedAt: Date.now(),
      };
      this._dirty = true;
    } catch (e) {
      console.warn('[TeletextSource] Calendar fetch failed:', e.message);
    } finally {
      this._fetchInFlight.calendar = false;
    }
  }

  /** Drop cached weather and fetch again — after the location changes. */
  refreshWeather(ps) {
    delete this._cachedData.weather;
    this._fetchInFlight.weather = false;
    this._fetchWeather(ps);
  }

  fetchCalendar(url) {
    if (url !== undefined) localStorage.setItem('imweb-teletext-ics-url', url);
    delete this._cachedData.calendar;
    this._fetchInFlight.calendar = false;
    this._dispatchFetch('calendar');
  }

  setMovieInput(movieInput) {
    this._movieInput = movieInput;
  }

  get pageId() {
    return PAGE_IDS[this._pageIdx] ?? 'P100';
  }

  dispose() {
    clearInterval(this._clockTimer);
    if (this._subPageTimer) clearInterval(this._subPageTimer);
    if (this._uiRefreshTimer) clearInterval(this._uiRefreshTimer);
    this.texture.dispose();
  }
}
