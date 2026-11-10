/**
 * ImWeb Window — visitor queue (Cloudflare Worker + one Durable Object).
 *
 *   phone  POST /api/visit {name, prompts[3], consent}  → {id}
 *   phone  GET  /api/visit/:id                         → state, people ahead, results
 *   phone  GET  /api/visit/:id/img/:n                  → the n-th picture (JPEG)
 *   kiosk  GET  /api/kiosk?key=…  (WebSocket)          → jobs out, pictures in
 *
 * ONE Durable Object ("window") holds the whole queue, so ordering needs no
 * locking. One visitor is at the window at a time: the kiosk asks for work
 * with {type:'ready'} and gets one job; it reports state, sends each picture,
 * then {type:'finished'} and 'ready' again.
 *
 * Pictures are JPEGs the kiosk re-encodes to ≤1024 px, stored as base64 in DO
 * storage (a value may be up to 2 MB) — no R2 bucket to enable. Everything a
 * visit holds is deleted 24 h after it was made (an alarm sweeps).
 */
import { DurableObject } from "cloudflare:workers";

const NAME_MAX = 16;
const PROMPT_MAX = 300;
const KEEP_MS = 24 * 3600 * 1000;
const SWEEP_MS = 3600 * 1000;
const IMG_B64_MAX = 1_900_000;
// The window calls each visitor by colour — no name has to go on the glass.
const COLOURS = [
  ["Green", "#2ecc71"], ["Orange", "#ff8c1a"], ["Blue", "#3d8bff"], ["Pink", "#ff4fa3"],
  ["Yellow", "#ffd23d"], ["Purple", "#a05cff"], ["Red", "#ff4a3d"], ["Teal", "#1fd1c1"],
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) {
      return env.WINDOW.get(env.WINDOW.idFromName("window")).fetch(req);
    }
    return new Response("Not found", { status: 404 }); // assets are served before this
  },
};

export class Window extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/api/kiosk") return this.kioskConnect(req, url);
    if (p === "/api/visit" && req.method === "POST") return this.newVisit(req);
    let m = p.match(/^\/api\/visit\/([a-f0-9]{20})$/);
    if (m && req.method === "GET") return this.visitStatus(m[1]);
    m = p.match(/^\/api\/visit\/([a-f0-9]{20})\/img\/([0-2])$/);
    if (m && req.method === "GET") return this.visitImage(m[1], Number(m[2]));
    return json({ error: "not found" }, 404);
  }

  // ── phone side ───────────────────────────────────────────────────────────
  async newVisit(req) {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
    const prompts = Array.isArray(body?.prompts)
      ? body.prompts.map((s) => String(s ?? "").trim().slice(0, PROMPT_MAX))
      : [];
    if (prompts.length !== 3 || prompts.some((s) => !s)) {
      return json({ error: "Write all three instructions." }, 400);
    }
    if (body.consent !== true) {
      return json({ error: "Tick the box to agree to the photo." }, 400);
    }
    const name = String(body.name ?? "").trim().slice(0, NAME_MAX);
    const s = this.ctx.storage;
    const n = (await s.get("n")) ?? 0;
    const id = [...crypto.getRandomValues(new Uint8Array(10))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const visit = {
      id, name, prompts,
      colour: COLOURS[n % COLOURS.length],
      state: "queued", error: null,
      results: [false, false, false],
      created: Date.now(),
    };
    const queue = (await s.get("queue")) ?? [];
    queue.push(id);
    await s.put({ n: n + 1, [`v:${id}`]: visit, queue });
    if ((await s.getAlarm()) === null) await s.setAlarm(Date.now() + SWEEP_MS);
    await this.pump();
    return json({ id });
  }

  async visitStatus(id) {
    const s = this.ctx.storage;
    const v = await s.get(`v:${id}`);
    if (!v) return json({ error: "not found" }, 404);
    const queue = (await s.get("queue")) ?? [];
    const current = (await s.get("current")) ?? null;
    const i = queue.indexOf(id);
    return json({
      state: v.state,
      error: v.error,
      colour: v.colour,
      name: v.name,
      prompts: v.prompts,
      results: v.results,
      ahead: i === -1 ? 0 : i + (current ? 1 : 0),
      windowOnline: this.ctx.getWebSockets("kiosk").length > 0,
    });
  }

  async visitImage(id, n) {
    const b64 = await this.ctx.storage.get(`img:${id}:${n}`);
    if (!b64) return new Response("Not found", { status: 404 });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=86400",
        "content-disposition": `inline; filename="imweb-window-${n + 1}.jpg"`,
      },
    });
  }

  // ── kiosk side ───────────────────────────────────────────────────────────
  kioskConnect(req, url) {
    if (!this.env.KIOSK_KEY) return json({ error: "KIOSK_KEY is not set" }, 503);
    if (url.searchParams.get("key") !== this.env.KIOSK_KEY) return json({ error: "forbidden" }, 403);
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected a WebSocket" }, 426);
    // One window: a new connection replaces the old one.
    for (const old of this.ctx.getWebSockets("kiosk")) {
      try { old.close(4000, "replaced"); } catch { /* already gone */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["kiosk"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = this.ctx.storage;
    const current = (await s.get("current")) ?? null;

    switch (msg.type) {
      case "hello": {
        // The kiosk says which job (if any) it is still working on. A job we
        // think is running that the kiosk does NOT have was lost in a dropped
        // connection — put it back at the head of the line.
        if (current && msg.current !== current) {
          const queue = (await s.get("queue")) ?? [];
          const v = await s.get(`v:${current}`);
          if (v) {
            v.state = "queued";
            v.results = [false, false, false]; // the retry makes all three again
            await s.put(`v:${current}`, v);
            queue.unshift(current);
          }
          await s.put("queue", queue);
          await s.delete("current");
        }
        return;
      }
      case "ready":
        await s.put("kioskReady", true);
        await this.pump();
        return;
      case "state": {
        if (msg.id !== current) return;
        const v = await s.get(`v:${current}`);
        if (!v || !["up", "countdown", "working"].includes(msg.state)) return;
        v.state = msg.state;
        await s.put(`v:${current}`, v);
        return;
      }
      case "result": {
        const n = Number(msg.n);
        if (msg.id !== current || !(n >= 0 && n <= 2)) return;
        if (typeof msg.b64 !== "string" || msg.b64.length > IMG_B64_MAX) return;
        const v = await s.get(`v:${current}`);
        if (!v) return;
        v.results[n] = true;
        await s.put({ [`img:${current}:${n}`]: msg.b64, [`v:${current}`]: v });
        return;
      }
      case "finished": {
        if (msg.id !== current) return;
        const v = await s.get(`v:${current}`);
        if (v) {
          v.state = msg.error ? "error" : "done";
          v.error = msg.error ? String(msg.error).slice(0, 200) : null;
          await s.put(`v:${current}`, v);
        }
        await s.delete("current");
        return;
      }
    }
  }

  async webSocketClose() { await this.ctx.storage.put("kioskReady", false); }
  async webSocketError() { await this.ctx.storage.put("kioskReady", false); }

  /** Hand the next visitor to the window, if it is free and asking. */
  async pump() {
    const s = this.ctx.storage;
    const [ws] = this.ctx.getWebSockets("kiosk");
    if (!ws || (await s.get("current")) || !(await s.get("kioskReady"))) return;
    const queue = (await s.get("queue")) ?? [];
    while (queue.length) {
      const id = queue.shift();
      const v = await s.get(`v:${id}`);
      if (!v) continue; // swept
      v.state = "up";
      await s.put({ queue, current: id, kioskReady: false, [`v:${id}`]: v });
      ws.send(JSON.stringify({ type: "job", id, name: v.name, colour: v.colour, prompts: v.prompts }));
      return;
    }
    await s.put("queue", queue);
  }

  /** Delete every visit (and its pictures) older than KEEP_MS. */
  async alarm() {
    const s = this.ctx.storage;
    const now = Date.now();
    const visits = await s.list({ prefix: "v:" });
    const gone = [];
    for (const [key, v] of visits) {
      if (now - v.created > KEEP_MS) gone.push(key, `img:${v.id}:0`, `img:${v.id}:1`, `img:${v.id}:2`);
    }
    if (gone.length) {
      for (let i = 0; i < gone.length; i += 128) await s.delete(gone.slice(i, i + 128));
      const old = new Set(gone);
      const queue = ((await s.get("queue")) ?? []).filter((id) => !old.has(`v:${id}`));
      await s.put("queue", queue);
    }
    if (visits.size > gone.length / 4) await s.setAlarm(now + SWEEP_MS);
  }
}
