/**
 * ImWeb Window — visitor queue (Cloudflare Worker + one Durable Object).
 *
 *   phone  POST /api/visit {name, prompts[3], consent}  → {id}
 *   phone  GET  /api/visit/:id                         → state, people ahead, results
 *   phone  GET  /api/visit/:id/img/:n                  → the n-th picture (JPEG)
 *   kiosk  GET  /api/kiosk?key=…  (WebSocket)          → jobs out, pictures in
 *   kiosk  POST /api/kiosk/reimagine {key,id,n,frame}  → one AI image for the visit
 *
 * ONE Durable Object ("window") holds the whole queue, so ordering needs no
 * locking. One visitor is at the window at a time: the kiosk asks for work
 * with {type:'ready'} and gets one job; it reports state, sends each picture,
 * then {type:'finished'} and 'ready' again.
 *
 * The AI call is made HERE, with the Worker's own GEMINI_API_KEY, not in the
 * window's browser. That is what lets the server hold the two limits: a visit
 * gets its three pictures and no more, and the window stops at DAILY_IMAGE_CAP
 * pictures a day. The instruction sent to the AI is the one the visitor
 * stored, never one the kiosk supplies.
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
const FRAME_B64_MAX = 1_500_000;
// Each of a visit's three pictures may be asked for twice: once, and once more
// if the first was made but lost with a dropped connection before it reached
// the phone. Six requests is the most one visit can ever cost.
const TRIES_PER_PICTURE = 2;
const DEFAULT_MODEL = "gemini-3.1-flash-image";
const DEFAULT_DAILY_CAP = 150;
const GEMINI_BASE = "https://generativelanguage.googleapis.com";
// Same list and same wording as reimagineImage() in src/ai/AIFeatures.js.
const ASPECTS = [
  ["21:9", 21 / 9], ["16:9", 16 / 9], ["3:2", 3 / 2], ["4:3", 4 / 3], ["5:4", 5 / 4],
  ["1:1", 1], ["4:5", 4 / 5], ["3:4", 3 / 4], ["2:3", 2 / 3], ["9:16", 9 / 16],
];
// The kiosk page is on another origin (ImWeb's own), so its POST needs CORS.
// The kiosk key in the body is what guards the route, not the origin.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const today = () => new Date().toISOString().slice(0, 10); // UTC, which is Iceland's clock
// The window calls each visitor by colour — no name has to go on the glass.
const COLOURS = [
  ["Green", "#2ecc71"], ["Orange", "#ff8c1a"], ["Blue", "#3d8bff"], ["Pink", "#ff4fa3"],
  ["Yellow", "#ffd23d"], ["Purple", "#a05cff"], ["Red", "#ff4a3d"], ["Teal", "#1fd1c1"],
];

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
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
    if (p === "/api/kiosk/reimagine") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "POST") return this.kioskReimagine(req);
    }
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
    // Nobody joins a line the window cannot finish today.
    const waiting = ((await s.get("queue")) ?? []).length + ((await s.get("current")) ? 1 : 0);
    if ((await this.madeToday()) + 3 * (waiting + 1) > this.dailyCap()) {
      return json({ error: "The window has made all its pictures for today. Come back tomorrow." }, 429);
    }
    const n = (await s.get("n")) ?? 0;
    const id = [...crypto.getRandomValues(new Uint8Array(10))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const visit = {
      id, name, prompts,
      colour: COLOURS[n % COLOURS.length],
      state: "queued", error: null,
      results: [false, false, false],
      tries: [0, 0, 0],
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
            // Pictures already on the phone stay there: the retry makes only
            // the missing ones, so a dropped connection is not a free visit.
            v.state = "queued";
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

  // ── the AI call ──────────────────────────────────────────────────────────
  dailyCap() {
    const n = Number(this.env.DAILY_IMAGE_CAP);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
  }

  async madeToday() { return (await this.ctx.storage.get(`day:${today()}`)) ?? 0; }

  /**
   * One picture for the visitor at the window. Refused unless it is that
   * visit's turn, the picture is still owed, and today's cap has room. Both
   * counts are taken BEFORE the call and given back if it fails: the object
   * serves other requests while it waits on the AI, and a count taken after
   * would let two requests through one remaining place.
   */
  async kioskReimagine(req) {
    const fail = (error, status) => json({ error }, status, CORS);
    let body;
    try { body = await req.json(); } catch { return fail("bad request", 400); }
    if (!this.env.KIOSK_KEY || body?.key !== this.env.KIOSK_KEY) return fail("forbidden", 403);
    if (!this.env.GEMINI_API_KEY) return fail("the window has no AI key", 503);
    const s = this.ctx.storage;
    const id = String(body.id ?? "");
    const n = Number(body.n);
    if (!id || id !== ((await s.get("current")) ?? null)) return fail("it is not this visit's turn", 409);
    if (!Number.isInteger(n) || n < 0 || n > 2) return fail("bad request", 400);
    const frame = body.frame;
    if (typeof frame?.b64 !== "string" || !frame.b64 || frame.b64.length > FRAME_B64_MAX
      || !/^image\/(jpeg|png|webp)$/.test(frame.mime ?? "")) return fail("bad picture", 400);
    const v = await s.get(`v:${id}`);
    if (!v) return fail("the visit is gone", 404);
    v.tries ??= [0, 0, 0];
    if (v.results[n] || v.tries[n] >= TRIES_PER_PICTURE) return fail("this picture was already made", 409);
    const day = `day:${today()}`;
    const made = (await s.get(day)) ?? 0;
    if (made >= this.dailyCap()) return fail("the window has made all its pictures for today", 429);
    v.tries[n]++;
    await s.put({ [day]: made + 1, [`v:${id}`]: v });

    try {
      const aspect = Number(body.aspect) || 16 / 9;
      let out;
      // An answer with no picture in it (finishReason NO_IMAGE and the like)
      // is often a one-off: ask once more before the visitor loses the visit.
      try { out = await this.gemini(frame, v.prompts[n], aspect); } catch (err) {
        if (!err.noImage) throw err;
        console.warn("[window] no picture in the answer, asking again:", err.message);
        out = await this.gemini(frame, v.prompts[n], aspect);
      }
      return json(out, 200, CORS);
    } catch (err) {
      // Read again: phones and the kiosk kept talking to us during the call.
      const now = await s.get(`v:${id}`);
      if (now?.tries) { now.tries[n] = Math.max(0, now.tries[n] - 1); await s.put(`v:${id}`, now); }
      await s.put(day, Math.max(0, ((await s.get(day)) ?? 1) - 1));
      console.warn("[window] AI call failed:", err.message);
      // The visitor reads this on the glass and on the phone: no model jargon.
      return fail(err.noImage
        ? `the AI would not make picture ${n + 1}. Try other words`
        : err.message, 502);
    }
  }

  /** The same request reimagineImage() makes in ImWeb (src/ai/AIFeatures.js). */
  async gemini(image, prompt, aspect) {
    const model = this.env.GEMINI_MODEL || DEFAULT_MODEL;
    const aspectRatio = ASPECTS.reduce((best, a) =>
      Math.abs(Math.log(a[1] / aspect)) < Math.abs(Math.log(best[1] / aspect)) ? a : best)[0];
    const text =
      `Reinterpret this image: ${prompt.trim() || "as a painting"}. ` +
      "Keep the composition, the main shapes and their positions where they are, " +
      "so the result can crossfade with the original. Return only the image.";
    const base = this.env.GEMINI_API_BASE || GEMINI_BASE; // overridden only by the test rig
    const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ inline_data: { mime_type: image.mime, data: image.b64 } }, { text }],
        }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error?.message ?? `Gemini error ${res.status}`);
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    // A thought part can carry an interim image: the last non-thought one is the answer.
    const img = parts.filter((p) => !p.thought).map((p) => p.inlineData ?? p.inline_data)
      .filter((d) => d?.data).pop();
    if (!img) {
      const said = parts.map((p) => p.text ?? "").join(" ").trim();
      const why = data.promptFeedback?.blockReason ?? cand?.finishReason ?? "no image in the answer";
      const err = new Error(said ? `${why}: ${said.slice(0, 160)}` : String(why));
      err.noImage = true;
      throw err;
    }
    return { b64: img.data, mime: img.mimeType ?? img.mime_type ?? "image/png" };
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
      ws.send(JSON.stringify({
        type: "job", id, name: v.name, colour: v.colour, prompts: v.prompts, results: v.results,
      }));
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
    // Yesterday's picture counts go too.
    const days = [...(await s.list({ prefix: "day:" })).keys()].filter((k) => k !== `day:${today()}`);
    if (days.length) await s.delete(days);
    if (visits.size > gone.length / 4) await s.setAlarm(now + SWEEP_MS);
  }
}
