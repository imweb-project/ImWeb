// P150 — RSS Headlines
// RSS/Atom XML fetched by TeletextSource.fetchText (direct, else the user's
// proxy) and parsed with DOMParser.

import { CANVAS_W, CH, COLS, XSCALE, drawHeader, ttRow, ttCentered, ttRule } from '../teletext_draw.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|undefined} data    { items, feedTitle, fetchedAt }
 * @param {number} subPageIdx
 * @param {number} [cursorIdx]
 */
export function renderP150(ctx, data, subPageIdx, cursorIdx = 0) {
  drawHeader(ctx, '150', 'HEADLINES');

  if (data?.error) {
    let host = '';
    try { host = new URL(data.url).hostname.replace(/^www\./, ''); } catch { /* bad URL */ }
    ttCentered(ctx, 'FEED UNAVAILABLE', 3, '#ff4444');
    ttCentered(ctx, host.toUpperCase().slice(0, COLS - 2), 5, '#ffffff');
    ttCentered(ctx, data.error.toUpperCase().slice(0, COLS - 2), 6, '#ffff00');
    if (data.error === 'needs a proxy') {
      ttCentered(ctx, 'This site blocks direct reading.', 8, '#888888');
      ttCentered(ctx, 'Pick a feed marked "direct",', 9, '#888888');
      ttCentered(ctx, 'or set a proxy in the panel.', 10, '#888888');
    }
    return;
  }

  if (!data || !data.items || !data.items.length) {
    ttCentered(ctx, 'FETCHING HEADLINES...', 3, '#888888');
    ttCentered(ctx, 'Connect an RSS feed below', 5, '#555555');
    return;
  }

  const items = data.items;
  const title = data.feedTitle || '';

  // Feed source name — right-aligned on row 1
  ctx.save();
  ctx.scale(XSCALE, 1);
  ctx.font = `bold 20px 'Courier New', monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#444444';
  ctx.fillText(title.substring(0, COLS), (CANVAS_W - 4) / XSCALE, 1 * CH + CH * 0.82);
  ctx.restore();
  ctx.textAlign = 'left';

  // 8 items per sub-page; wrapped items take 2 rows
  const perPage = 8;
  const start = subPageIdx * perPage;
  const slice = items.slice(start, start + perPage);
  const maxW = COLS - 5; // 35 chars for title after 5-char prefix

  let row = 2;
  slice.forEach((item, i) => {
    const title = item.title || '';
    const num = (start + i + 1).toString().padStart(2, ' ');
    const prefix = ` ${num}. `;

    const wraps = title.length > maxW;
    const lines = 1 + (wraps ? 1 : 0);

    // Cursor highlight — one or two rows
    if (i === cursorIdx) {
      ctx.fillStyle = '#004400';
      ctx.fillRect(0, row * CH, CANVAS_W, lines * CH);
    }

    const color = (i % 2 === 0) ? '#ffffff' : '#aaaaaa';

    if (!wraps) {
      ttRow(ctx, prefix + title, row, color);
    } else {
      const bp = title.lastIndexOf(' ', maxW);
      const cut = bp > 0 ? bp : maxW;
      const part1 = title.slice(0, cut);
      const indent = ' '.repeat(prefix.length);
      const part2 = title.slice(cut).trim().slice(0, COLS - indent.length);
      ttRow(ctx, prefix + part1, row, color);
      ttRow(ctx, indent + part2, row + 1, color);
    }

    row += lines;
  });

  // Page indicator — draw after all content rows
  const totalPages = Math.ceil(items.length / perPage);
  ttCentered(ctx, `PAGE ${subPageIdx + 1} OF ${totalPages}`, row + 1, '#888888');

  // Timestamp
  const ts = data.fetchedAt ? new Date(data.fetchedAt) : null;
  if (ts) {
    const hhmm = [ts.getHours(), ts.getMinutes()].map(n => String(n).padStart(2, '0')).join(':');
    ttCentered(ctx, `LAST UPDATE: ${hhmm}`, row + 3, '#444444');
  }

  return totalPages;
}
