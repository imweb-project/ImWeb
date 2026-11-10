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
   The kiosk key comes from `window-kiosk/.dev.vars` (`KIOSK_KEY=…`, not committed).
2. In ImWeb, go to Reimagine ▸ Window Visitors. Enter the URL
   `ws://localhost:8787/api/kiosk?key=<KIOSK_KEY>`, turn the camera on and tick **Serve visitors**.
   Reimagine needs a Gemini key, and **Follow** is switched on for each visit.
3. Open http://localhost:8787 on a phone on the same network (use the Mac's IP
   address instead of localhost) or in a narrow browser tab.

## Deploy (not done yet)

`npx wrangler deploy --config window-kiosk/wrangler.jsonc`, then
`npx wrangler secret put KIOSK_KEY --config window-kiosk/wrangler.jsonc`. The kiosk URL then becomes
`wss://<worker-host>/api/kiosk?key=…`.

## What it does not do yet

- **Payment:** anyone can join the line.
- **Moderation:** names and instructions go on the glass unchecked.
- **The Gemini call is in the window's browser.** Moving it to the Worker
  would let the server enforce "paid = exactly 3" and a daily spending cap.
- Visits and pictures are deleted 24 h after they were made (hourly sweep).
