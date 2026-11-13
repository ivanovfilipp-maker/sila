// «Сила» server: exact-time rest-timer push + automatic backups. One owner, one Durable Object.
import { sendPush, newVapid } from "./push.js";

const SUBJECT = "https://ivanovfilipp-maker.github.io/sila/";
const CHUNK = 60000, KEEP_DAYS = 30, VERSION = 1;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const stub = env.SILA.get(env.SILA.idFromName("main"));
    return stub.fetch(req);
  }
};

async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function countWorkouts(text) { try { const o = JSON.parse(text); return { w: (o.workouts || []).length, f: ((o.food || {}).log || []).length }; } catch (e) { return null; } }

export class Sila {
  constructor(state, env) { this.state = state; this.st = state.storage; this.env = env; this.fetchFn = (...a) => fetch(...a); }

  async vapid() {
    let v = await this.st.get("vapid");
    if (!v) { v = await newVapid(); await this.st.put("vapid", v); }
    return v;
  }
  async authed(req) {
    const owner = await this.st.get("owner"), h = req.headers.get("Authorization") || "";
    const code = h.startsWith("Bearer ") ? h.slice(7).trim().toUpperCase() : "";
    if (!code || code.length < 12) return { ok: false, owner };
    return { ok: owner ? owner === await sha(code) : false, owner, code };
  }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p === "/" || p === "/info") {
        const v = await this.vapid();
        return json({ ok: true, app: "sila", version: VERSION, claimed: !!(await this.st.get("owner")), vapid: v.pub });
      }
      const a = await this.authed(req);
      if (p === "/claim" && req.method === "POST") {
        if (!a.code || a.code.length < 12) return json({ ok: false, error: "bad code" }, 400);
        if (!a.owner) { await this.st.put("owner", await sha(a.code)); return json({ ok: true, claimed: true, fresh: true }); }
        return a.ok ? json({ ok: true, claimed: true }) : json({ ok: false, error: "wrong code" }, 403);
      }
      if (!a.ok) return json({ ok: false, error: a.owner ? "wrong code" : "not claimed" }, 403);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

      if (p === "/sub") {
        const s = body.sub; if (!s || !s.endpoint || !s.keys) return json({ ok: false, error: "bad sub" }, 400);
        const subs = (await this.st.get("subs")) || {};
        subs[s.endpoint] = { endpoint: s.endpoint, keys: s.keys, t: Date.now() };
        const keys = Object.keys(subs).sort((x, y) => subs[y].t - subs[x].t); keys.slice(5).forEach(k => delete subs[k]);
        await this.st.put("subs", subs);
        return json({ ok: true, devices: Object.keys(subs).length });
      }
      if (p === "/unsub") { const subs = (await this.st.get("subs")) || {}; delete subs[body.endpoint]; await this.st.put("subs", subs); return json({ ok: true }); }
      if (p === "/timer") {
        const at = +body.at; if (!(at > 0)) return json({ ok: false, error: "bad time" }, 400);
        const t = { at, title: String(body.title || "Отдых окончен").slice(0, 80), body: String(body.body || "").slice(0, 160), id: String(body.id || at) };
        await this.st.put("timer", t);
        if (at <= Date.now() + 300) { await this.fire(); return json({ ok: true, sent: true }); }
        await this.st.setAlarm(at);
        return json({ ok: true, at });
      }
      if (p === "/cancel") { await this.st.delete("timer"); await this.st.deleteAlarm(); return json({ ok: true }); }
      if (p === "/backup" && req.method === "POST") return json(await this.saveBackup(body));
      if (p === "/backups") return json({ ok: true, list: await this.listBackups() });
      if (p === "/backup") {
        const slot = url.searchParams.get("slot") || "latest";
        const data = await this.readSlot(slot);
        return data == null ? json({ ok: false, error: "no backup" }, 404) : json({ ok: true, slot, meta: await this.st.get("m:" + slot), data });
      }
      if (p === "/status") {
        const subs = (await this.st.get("subs")) || {};
        return json({ ok: true, devices: Object.keys(subs).length, latest: (await this.st.get("m:latest")) || null, timer: (await this.st.get("timer")) || null });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }

  async alarm() { await this.fire(); }
  async fire() {
    const t = await this.st.get("timer"); if (!t) return;
    await this.st.delete("timer");
    const subs = (await this.st.get("subs")) || {}, v = await this.vapid();
    let changed = false;
    await Promise.all(Object.keys(subs).map(async k => {
      try {
        const r = await sendPush(subs[k], { title: t.title, body: t.body, tag: "sila-rest", id: t.id }, v, SUBJECT, this.fetchFn);
        if (r.status === 404 || r.status === 410) { delete subs[k]; changed = true; }
      } catch (e) {}
    }));
    if (changed) await this.st.put("subs", subs);
  }

  async writeSlot(slot, data, meta) {
    const old = (await this.st.get("m:" + slot)) || { chunks: 0 };
    const n = Math.ceil(data.length / CHUNK) || 1, put = {};
    for (let i = 0; i < n; i++) put["c:" + slot + ":" + i] = data.slice(i * CHUNK, (i + 1) * CHUNK);
    const ks = Object.keys(put);
    for (let i = 0; i < ks.length; i += 100) { const part = {}; ks.slice(i, i + 100).forEach(k => part[k] = put[k]); await this.st.put(part); }
    await this.st.put("m:" + slot, { ...meta, chunks: n });
    const del = []; for (let i = n; i < old.chunks; i++) del.push("c:" + slot + ":" + i);
    if (del.length) await this.st.delete(del);
  }
  async readSlot(slot) {
    const m = await this.st.get("m:" + slot); if (!m) return null;
    const keys = []; for (let i = 0; i < m.chunks; i++) keys.push("c:" + slot + ":" + i);
    const got = await this.st.get(keys); return keys.map(k => got.get(k) || "").join("");
  }
  async dropSlot(slot) {
    const m = await this.st.get("m:" + slot); if (!m) return;
    const keys = ["m:" + slot]; for (let i = 0; i < m.chunks; i++) keys.push("c:" + slot + ":" + i);
    await this.st.delete(keys);
  }
  async saveBackup(b) {
    const data = String(b.data || ""), cnt = countWorkouts(data);
    if (!cnt) return { ok: false, error: "not app data" };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : new Date().toISOString().slice(0, 10);
    const meta = { ts: Date.now(), day, size: data.length, workouts: cnt.w, food: cnt.f, ver: String(b.ver || "") };
    const best = (await this.st.get("best")) || 0;
    // Guard: never let a wiped/fresh copy overwrite a fuller history automatically.
    if (!b.force && cnt.w < best - 1) { await this.writeSlot("suspect", data, meta); return { ok: true, suspect: true, best, workouts: cnt.w }; }
    await this.writeSlot("latest", data, meta);
    await this.writeSlot("d:" + day, data, meta);
    await this.st.put("best", b.force ? cnt.w : Math.max(best, cnt.w));
    const days = ((await this.st.get("days")) || []).filter(d => d !== day); days.push(day); days.sort();
    while (days.length > KEEP_DAYS) await this.dropSlot("d:" + days.shift());
    await this.st.put("days", days);
    return { ok: true, ts: meta.ts, workouts: cnt.w };
  }
  async listBackups() {
    const days = (await this.st.get("days")) || [], out = [];
    for (const s of ["latest", "suspect"].concat(days.slice().reverse().map(d => "d:" + d))) { const m = await this.st.get("m:" + s); if (m) out.push({ slot: s, ...m }); }
    return out;
  }
}
// deploy 2026-11-13T07:07:51Z
