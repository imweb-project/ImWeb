// P401 — Hourly Forecast
// Renders next 12 hours from Open-Meteo hourly data.

import { drawHeader, ttRow, ttCentered, ttRule } from '../teletext_draw.js';
import { WMO_CODES } from './wmo_codes.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|undefined} data  Open-Meteo JSON response
 */
export function renderP401(ctx, data) {
  drawHeader(ctx, '401', 'HOURLY FORECAST');

  if (!data || !data.hourly) {
    ttCentered(ctx, 'FETCHING FORECAST DATA...', 3, '#888888');
    return;
  }

  const h = data.hourly;
  const times   = h.time   || [];
  const temps   = h.temperature_2m || [];
  const precip  = h.precipitation_probability || [];
  const codes   = h.weather_code || [];

  // First hour at or after NOW AT THE LOCATION. The hourly times are the
  // location's local time (timezone=auto), and so is current.time — compare
  // those two. The viewer's clock hour paired with a UTC date matched the
  // wrong day for any location in another zone, and after midnight anywhere.
  const nowHour = (data.current?.time ?? '').substring(0, 13); // YYYY-MM-DDTHH
  let startIdx = nowHour ? times.findIndex(t => t.substring(0, 13) >= nowHour) : 0;
  if (startIdx < 0) startIdx = 0;

  // Column header
  ttRow(ctx, '  TIME       TEMP    PRECIP%    CONDITION', 1, '#888888');

  // 12 rows (rows 2–13)
  for (let i = 0; i < 12 && (startIdx + i) < times.length; i++) {
    const idx = startIdx + i;
    const r = 2 + i;
    const tStr  = times[idx]?.substring(11, 16) ?? '--:--';
    const tVal  = temps[idx]  ?? '--';
    const pVal  = precip[idx] ?? '--';
    const wCode = codes[idx]  ?? -1;
    const cond  = WMO_CODES[wCode] ?? '--';

    let color = '#00ffff';
    if (i === 0) color = '#00ff00'; // current hour in green

    const line = `  ${tStr}     ${String(tVal).padStart(3)}\u00B0C     ${String(pVal).padEnd(3)}%     ${cond}`;
    ttRow(ctx, line, r, color);
  }

  // Row 15: rule
  ttRule(ctx, 15);

  // Row 22: Timestamp
  const ts = data._fetchedAt ? new Date(data._fetchedAt) : null;
  if (ts) {
    const hhmm = [ts.getHours(), ts.getMinutes()].map(n => String(n).padStart(2, '0')).join(':');
    ttCentered(ctx, `LAST UPDATE: ${hhmm}`, 22, '#444444');
  }
}
