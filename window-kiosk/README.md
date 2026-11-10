# ImWeb Window — visitor queue (prototype)

Passers-by queue from their phones. The ImWeb running in the shop window
photographs each visitor and reimagines them with their three instructions.

```
phone (QR → /)  ──POST /api/visit──▶  Worker → Durable Object "window"  ◀──WebSocket──  ImWeb
                ◀─poll /api/visit/:id─                                   (Reimagine ▸ Window Visitors)
```

## Run locally

1. `npx wrangler dev --config window-kiosk/wrangler.jsonc` serves on http://localhost:8787
   (the `window-kiosk` entry in `.claude/launch.json` runs the same command).
   Two secrets come from `window-kiosk/.dev.vars` (not committed), one per line:
   `KIOSK_KEY=…` (any password you choose) and `GEMINI_API_KEY=…` (the Google
   Gemini key that pays for visitors' pictures).
2. In ImWeb, go to Reimagine ▸ Window Visitors. Enter the URL
   `ws://localhost:8787/api/kiosk?key=<KIOSK_KEY>`, turn the camera on and tick **Serve visitors**.
   **Follow** is switched on for each visit. Visitors' pictures are made by this
   server with its own key; ImWeb's key and Model menu are only used by the
   attract loop between visitors.
3. Open http://localhost:8787 on a phone on the same network (use the Mac's IP
   address instead of localhost) or in a narrow browser tab.

## Deploy (not done yet)

`npx wrangler deploy --config window-kiosk/wrangler.jsonc`, then
`npx wrangler secret put KIOSK_KEY --config window-kiosk/wrangler.jsonc` and the same for
`GEMINI_API_KEY`. The kiosk URL then becomes
`wss://<worker-host>/api/kiosk?key=…`.

## Limits the server holds

- **Three pictures per visit.** The server makes each picture itself, from the
  instruction the visitor stored. A picture that was made but lost with a
  dropped connection may be made once more, so one visit costs six requests at
  the very most; pictures already on the phone are never made again.
- **A failed picture** (the AI answers with no image) is asked for once more by
  the server and is not counted. If it fails again the visit carries on and
  delivers the pictures that worked.
- **A daily cap**, `DAILY_IMAGE_CAP` in `wrangler.jsonc` (150 pictures, which is
  50 visitors; the day turns at midnight UTC). Nobody can join a line the
  window could not finish that day, and the phone says so.
- The image model is `GEMINI_MODEL` in `wrangler.jsonc`.

## What it does not do yet

- **Payment:** anyone can join the line.
- **Moderation:** names and instructions go on the glass unchecked.
- Visits and pictures are deleted 24 h after they were made (hourly sweep).
