// TeletextUI — page navigation buttons, sub-page arrows, RSS URL input.
// Exported function buildTeletextUI(container, ps, teletextSource, contextMenu).
// Follows the same pattern as buildAnalogPresetBar() in src/ui/UI.js.

import { buildParamRow } from '../ui/UI.js';
import { DEFAULT_RSS_URL, PROXY_KEY, PLACE_KEY } from './TeletextSource.js';

const PAGE_LABELS = ['P100', 'P150', 'P400', 'P401', 'P500', 'P700', 'P900'];
const RSS_KEY = 'imweb-teletext-rssUrl';
const ICS_KEY = 'imweb-teletext-ics-url';

/**
 * @param {HTMLElement} container       #teletext-params element
 * @param {object}      ps              ParameterSystem instance
 * @param {object}      teletextSource  TeletextSource instance
 */
export function buildTeletextUI(container, ps, teletextSource, contextMenu) {

  // Clear any existing UI refresh timer (defensive against re-init)
  if (teletextSource._uiRefreshTimer) {
    clearInterval(teletextSource._uiRefreshTimer);
    teletextSource._uiRefreshTimer = null;
  }

  // ── Page navigation buttons ───────────────────────────────────────────
  const navDiv = document.createElement('div');
  navDiv.className = 'tt-nav';
  container.appendChild(navDiv);

  const pageBtns = [];

  PAGE_LABELS.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.className = 'tt-nav-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      ps.set('teletext.page', i);
    });
    navDiv.appendChild(btn);
    pageBtns.push(btn);
  });

  // Set initial active button
  {
    const idx = ps.get('teletext.page')?.value ?? 0;
    pageBtns[idx]?.classList.add('active');
  }

  // Keep active button in sync when page changes externally (preset, MIDI, etc.)
  ps.get('teletext.page')?.onChange?.(v => {
    pageBtns.forEach((btn, i) => btn.classList.toggle('active', i === v));
  });

  // ── Sub-page trigger rows (MIDI/LFO assignable) ────────────────────────
  container.appendChild(buildParamRow(ps.get('teletext.subPagePrev'), contextMenu));
  container.appendChild(buildParamRow(ps.get('teletext.subPageNext'), contextMenu));
  container.appendChild(buildParamRow(ps.get('teletext.cursorUp'),     contextMenu));
  container.appendChild(buildParamRow(ps.get('teletext.cursorDown'),   contextMenu));
  container.appendChild(buildParamRow(ps.get('teletext.openItem'),     contextMenu));
  for (let i = 1; i <= 8; i++) {
    container.appendChild(buildParamRow(ps.get(`teletext.openItem${i}`), contextMenu));
  }
  container.appendChild(buildParamRow(ps.get('teletext.articleFetch'), contextMenu));

  // ── Sub-page navigation ───────────────────────────────────────────────
  const spDiv = document.createElement('div');
  spDiv.className = 'tt-subpage';
  container.appendChild(spDiv);

  const spPrev = document.createElement('button');
  spPrev.className = 'tt-subpage-btn';
  spPrev.textContent = '\u25C0';     // ◀
  spPrev.addEventListener('click', () => {
    if (teletextSource._subPageCount <= 1) return;
    teletextSource.prevSubPage();
  });

  const spLabel = document.createElement('span');
  spLabel.className = 'tt-subpage-label';

  const spNext = document.createElement('button');
  spNext.className = 'tt-subpage-btn';
  spNext.textContent = '\u25B6';     // ▶
  spNext.addEventListener('click', () => {
    if (teletextSource._subPageCount <= 1) return;
    teletextSource.nextSubPage();
  });

  spDiv.appendChild(spPrev);
  spDiv.appendChild(spLabel);
  spDiv.appendChild(spNext);

  // Refresh the sub-page label every 250ms
  teletextSource._uiRefreshTimer = setInterval(() => {
    const idx   = teletextSource._subPageIdx;
    const count = teletextSource._subPageCount;
    spLabel.textContent = (idx + 1) + ' / ' + count;
    const idle = count <= 1;
    spPrev.disabled = idle;
    spNext.disabled = idle;
    spDiv.classList.toggle('idle', idle);
  }, 250);

  // ── RSS URL input ─────────────────────────────────────────────────────
  const rssDiv = document.createElement('div');
  rssDiv.className = 'tt-rss-row';
  container.appendChild(rssDiv);

  const rssInput = document.createElement('input');
  rssInput.className = 'tt-rss-url';
  rssInput.type = 'text';
  rssInput.placeholder = 'RSS feed URL...';
  rssInput.value = localStorage.getItem(RSS_KEY) ?? '';
  rssInput.spellcheck = false;

  // ── RSS preset source dropdown ───────────────────────────────────────
  // `direct` feeds send Access-Control-Allow-Origin: * and load with no proxy
  // (checked 2026-10-30). The rest are refused by the browser unless a proxy
  // is set below — they stay listed, grouped, so the choice is honest.
  const RSS_PRESETS = [
    { label: 'NASA News',             url: DEFAULT_RSS_URL, direct: true },
    { label: 'NASA Image of the Day', url: 'https://www.nasa.gov/feeds/iotd-feed/', direct: true },
    { label: 'NYT World',             url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', direct: true },
    { label: 'NYT Art & Design',      url: 'https://rss.nytimes.com/services/xml/rss/nyt/ArtandDesign.xml', direct: true },
    { label: 'NYT Science',           url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', direct: true },
    { label: 'Wired Culture',         url: 'https://www.wired.com/feed/category/culture/latest/rss', direct: true },
    { label: 'Wired Science',         url: 'https://www.wired.com/feed/category/science/latest/rss', direct: true },
    { label: 'Open Culture',          url: 'https://www.openculture.com/feed', direct: true },
    { label: 'Pitchfork News',        url: 'https://pitchfork.com/rss/news/', direct: true },
    { label: 'Earthquakes (USGS)',    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.atom', direct: true },
    { label: 'BBC News',              url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { label: 'RÚV',                   url: 'https://www.ruv.is/rss/frettir' },
    { label: 'Yle Uutiset',           url: 'https://yle.fi/rss/uutiset/tuoreimmat' },
    { label: 'Al Jazeera',            url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { label: 'Guardian Art & Design', url: 'https://www.theguardian.com/artanddesign/rss' },
    { label: 'Dezeen',                url: 'https://www.dezeen.com/feed/' },
    { label: 'Hyperallergic',         url: 'https://hyperallergic.com/feed/' },
    { label: 'Creative Applications', url: 'https://www.creativeapplications.net/feed/' },
  ];

  const presetDiv = document.createElement('div');
  presetDiv.className = 'tt-rss-preset-row';

  const presetSelect = document.createElement('select');
  presetSelect.className = 'tt-rss-preset';

  // Build options
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select feed preset...';
  defaultOpt.disabled = true;
  presetSelect.appendChild(defaultOpt);

  [['Works directly', true], ['Needs a proxy', false]].forEach(([groupLabel, direct]) => {
    const group = document.createElement('optgroup');
    group.label = groupLabel;
    RSS_PRESETS.filter(p => !!p.direct === direct).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.url;
      opt.textContent = p.label;
      group.appendChild(opt);
    });
    presetSelect.appendChild(group);
  });

  const customOpt = document.createElement('option');
  customOpt.value = '';
  customOpt.textContent = 'Custom\u2026';
  presetSelect.appendChild(customOpt);

  // Pre-select matching preset (or custom if no match). Nothing stored means
  // the default feed is the one playing, so show it rather than a blank.
  const storedUrl = localStorage.getItem(RSS_KEY) || DEFAULT_RSS_URL;
  const matchedPreset = RSS_PRESETS.find(p => p.url === storedUrl);
  if (matchedPreset) {
    presetSelect.value = matchedPreset.url;
  } else if (storedUrl) {
    presetSelect.value = ''; // 'Custom…'
  }

  presetSelect.addEventListener('change', () => {
    const url = presetSelect.value;
    if (url) {
      rssInput.value = url;
      localStorage.setItem(RSS_KEY, url);
      if (teletextSource.fetchRSS) teletextSource.fetchRSS(url);
    } else {
      // 'Custom…' selected — focus the text input
      rssInput.select();
      rssInput.focus();
    }
  });

  presetDiv.appendChild(presetSelect);
  container.appendChild(presetDiv);

  const connectBtn = document.createElement('button');
  connectBtn.className = 'tt-connect-btn';
  connectBtn.textContent = 'Connect';
  connectBtn.addEventListener('click', () => {
    const url = rssInput.value.trim();
    localStorage.setItem(RSS_KEY, url);
    if (teletextSource.fetchRSS) {
      teletextSource.fetchRSS(url);
    }
  });
  // Enter key in input triggers connect
  rssInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); connectBtn.click(); }
  });

  rssDiv.appendChild(rssInput);
  rssDiv.appendChild(connectBtn);

  // ── Optional proxy ──────────────────────────────────────────────────────
  // For feeds marked "Needs a proxy". Stored per browser, never in a State or
  // the bundle: a proxy may carry the user's own key.
  const proxyDiv = document.createElement('div');
  proxyDiv.className = 'tt-rss-row';
  container.appendChild(proxyDiv);

  const proxyLabel = document.createElement('small');
  proxyLabel.className = 'tt-field-label';
  proxyLabel.textContent = 'Proxy for blocked feeds (optional) — URL with {url}';
  proxyDiv.appendChild(proxyLabel);

  const proxyInput = document.createElement('input');
  proxyInput.className = 'tt-rss-url';
  proxyInput.type = 'text';
  proxyInput.placeholder = 'https://your-proxy.example/?url={url}';
  proxyInput.value = localStorage.getItem(PROXY_KEY) ?? '';
  proxyInput.spellcheck = false;

  const proxyBtn = document.createElement('button');
  proxyBtn.className = 'tt-connect-btn';
  proxyBtn.textContent = 'Save';
  proxyBtn.addEventListener('click', () => {
    const v = proxyInput.value.trim();
    if (v) localStorage.setItem(PROXY_KEY, v); else localStorage.removeItem(PROXY_KEY);
    teletextSource.fetchRSS?.(localStorage.getItem(RSS_KEY) || DEFAULT_RSS_URL);
  });
  proxyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); proxyBtn.click(); }
  });
  proxyDiv.appendChild(proxyInput);
  proxyDiv.appendChild(proxyBtn);

  // ── Weather place search ────────────────────────────────────────────────
  // Open-Meteo's geocoder answers CORS directly, so no proxy. The result
  // writes teletext.latitude/longitude (params: MIDI-able, captured by
  // States) and remembers the name for P400 while those coordinates hold.
  const placeDiv = document.createElement('div');
  placeDiv.className = 'tt-rss-row';
  container.appendChild(placeDiv);

  const placeLabel = document.createElement('small');
  placeLabel.className = 'tt-field-label';
  placeLabel.textContent = 'Weather location (P400 / P401)';
  placeDiv.appendChild(placeLabel);

  const placeInput = document.createElement('input');
  placeInput.className = 'tt-rss-url';
  placeInput.type = 'text';
  placeInput.placeholder = 'City, e.g. Rovaniemi';
  placeInput.spellcheck = false;
  try { placeInput.value = JSON.parse(localStorage.getItem(PLACE_KEY))?.name ?? ''; } catch { /* none */ }

  const placeBtn = document.createElement('button');
  placeBtn.className = 'tt-connect-btn';
  placeBtn.textContent = 'Find';
  placeBtn.addEventListener('click', async () => {
    const q = placeInput.value.trim();
    if (!q) return;
    placeBtn.disabled = true;
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name='
        + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) });
      const hit = (await res.json()).results?.[0];
      if (!hit) { placeInput.value = ''; placeInput.placeholder = `"${q}" not found`; return; }
      const name = hit.country_code ? `${hit.name}, ${hit.country_code}` : hit.name;
      localStorage.setItem(PLACE_KEY, JSON.stringify({ name, lat: hit.latitude, lon: hit.longitude }));
      placeInput.value = name;
      ps.set('teletext.latitude', hit.latitude);
      ps.set('teletext.longitude', hit.longitude);
      teletextSource.refreshWeather?.(ps);
    } catch (e) {
      console.warn('[TeletextUI] Place search failed:', e.message);
    } finally {
      placeBtn.disabled = false;
    }
  });
  placeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); placeBtn.click(); }
  });
  placeDiv.appendChild(placeInput);
  placeDiv.appendChild(placeBtn);

  // ── Calendar ICS URL input ──────────────────────────────────────────────
  const calDiv = document.createElement('div');
  calDiv.className = 'tt-rss-row';
  container.appendChild(calDiv);

  const calLabel = document.createElement('small');
  calLabel.style.cssText = 'display:block;color:#556655;margin:4px 0 2px 0;font-size:10px;';
  calLabel.textContent = 'iCloud/Google .ics public URL (change webcal:// to https://)';
  calDiv.appendChild(calLabel);

  const calInput = document.createElement('input');
  calInput.className = 'tt-rss-url';
  calInput.type = 'text';
  calInput.placeholder = '.ics calendar URL...';
  calInput.value = localStorage.getItem(ICS_KEY) ?? '';
  calInput.spellcheck = false;

  const calBtn = document.createElement('button');
  calBtn.className = 'tt-connect-btn';
  calBtn.textContent = 'Connect';
  calBtn.addEventListener('click', () => {
    const url = calInput.value.trim();
    localStorage.setItem(ICS_KEY, url);
    if (teletextSource.fetchCalendar) teletextSource.fetchCalendar(url);
  });
  calInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); calBtn.click(); }
  });

  calDiv.appendChild(calInput);
  calDiv.appendChild(calBtn);
}
