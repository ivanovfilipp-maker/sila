// «Сила» server: exact-time rest-timer push + automatic backups.
// The "main" Durable Object belongs to the owner and keeps the user list; every invited user gets a Durable Object of
// their own ("u:<code hash>"), reached only through main, so nobody's data mixes with anyone else's.
import { sendPush, newVapid } from "./push.js";

const SUBJECT = "https://ivanovfilipp-maker.github.io/sila/";
const CHUNK = 60000, KEEP_DAYS = 30, VERSION = 2, INVITE_DAYS = 7, MAX_USERS = 20;
const INNER = "X-Sila-Inner";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const h = new Headers(req.headers); h.delete(INNER);          // only main may talk to a user's object
    const stub = env.SILA.get(env.SILA.idFromName("main"));
    return stub.fetch(new Request(req, { headers: h }));
  }
};

async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function token() { const al = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(8)); let s = ""; for (let i = 0; i < 8; i++) { s += al[b[i] % al.length]; if (i === 3) s += "-"; } return s; }
function normInv(t) { const s = String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4) : ""; }
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
    const hash = await sha(code);
    return { ok: owner ? owner === hash : false, owner, code, hash };
  }
  userStub(hash) { return this.env.SILA.get(this.env.SILA.idFromName("u:" + hash)); }
  inner(hash, path, body) { return this.userStub(hash).fetch(new Request("https://sila" + path, { method: "POST", headers: { [INNER]: "1" }, body: JSON.stringify(body || {}) })).then(r => r.json()); }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p.startsWith("/_")) return req.headers.get(INNER) === "1" ? json(await this.internal(p, await req.json().catch(() => ({})))) : json({ ok: false, error: "not found" }, 404);
      const isUser = !!(await this.st.get("isUser"));
      if (p === "/" || p === "/info") {
        const v = await this.vapid();
        return json({ ok: true, app: "sila", version: VERSION, claimed: !!(await this.st.get("owner")), vapid: v.pub });
      }
      const a = await this.authed(req);
      if (!isUser) {
        if (p === "/join" && req.method === "POST") return this.join(a, await req.json().catch(() => ({})));
        if (a.code && a.code.length >= 12 && !a.ok) {                 // an invited user: hand the request to their own object
          const users = (await this.st.get("users")) || {};
          if (users[a.hash]) { if (Date.now() - (users[a.hash].seen || 0) > 36e5) { users[a.hash].seen = Date.now(); await this.st.put("users", users); } return this.userStub(a.hash).fetch(req); }
        }
      }
      if (p === "/claim" && req.method === "POST") {
        if (isUser) return a.ok ? json({ ok: true, claimed: true, role: "user", name: (await this.st.get("name")) || "" }) : json({ ok: false, error: "wrong code" }, 403);
        if (!a.code || a.code.length < 12) return json({ ok: false, error: "bad code" }, 400);
        if (!a.owner) { await this.st.put("owner", a.hash); return json({ ok: true, claimed: true, fresh: true, role: "owner" }); }
        return a.ok ? json({ ok: true, claimed: true, role: "owner" }) : json({ ok: false, error: "wrong code" }, 403);
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
      if (!isUser && p === "/invite" && req.method === "POST") return json(await this.invite(body));
      if (!isUser && p === "/users") return json(await this.users());
      if (!isUser && p === "/user/del" && req.method === "POST") return json(await this.delUser(body));
      if (!isUser && p === "/invite/del" && req.method === "POST") { await this.st.delete("inv:" + normInv(body.invite)); const l = ((await this.st.get("invites")) || []).filter(x => x !== normInv(body.invite)); await this.st.put("invites", l); return json({ ok: true }); }
      if (p === "/status") {
        const subs = (await this.st.get("subs")) || {};
        return json({ ok: true, devices: Object.keys(subs).length, latest: (await this.st.get("m:latest")) || null, timer: (await this.st.get("timer")) || null });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }

  /* ---------- users (main object only) ---------- */
  async invite(b) {
    const users = (await this.st.get("users")) || {};
    if (Object.keys(users).length >= MAX_USERS) return { ok: false, error: "too many users" };
    const name = String(b.name || "").trim().slice(0, 40) || "Новый пользователь";
    const prog = b.prog ? String(b.prog) : "";
    if (prog.length > 400000) return { ok: false, error: "program too big" };
    if (prog) { try { const o = JSON.parse(prog); if (!o || o.sila !== 1) throw 0; } catch (e) { return { ok: false, error: "bad program" }; } }
    const t = token(), exp = Date.now() + INVITE_DAYS * 864e5;
    await this.st.put("inv:" + t, { name, prog, t: Date.now(), exp });
    const list = await this.cleanInvites(); list.push(t); await this.st.put("invites", list);
    return { ok: true, invite: t, exp, name };
  }
  async cleanInvites() {
    const list = (await this.st.get("invites")) || [], keep = [];
    for (const t of list) { const v = await this.st.get("inv:" + t); if (v && v.exp > Date.now()) keep.push(t); else await this.st.delete("inv:" + t); }
    return keep;
  }
  async join(a, b) {
    if (!a.code || a.code.length < 12) return json({ ok: false, error: "bad code" }, 400);
    const t = normInv(b.invite), inv = t && await this.st.get("inv:" + t);
    if (!inv || inv.exp < Date.now()) return json({ ok: false, error: "invite not valid" }, 404);
    const users = (await this.st.get("users")) || {};
    if (a.ok || users[a.hash]) return json({ ok: false, error: "code in use" }, 409);
    const v = await this.vapid();
    const r = await this.inner(a.hash, "/_init", { owner: a.hash, name: inv.name, vapid: v });
    if (!r.ok) return json({ ok: false, error: "init failed" }, 500);
    users[a.hash] = { id: a.hash.slice(0, 10), name: inv.name, t: Date.now(), seen: Date.now() };
    await this.st.put("users", users);
    await this.st.delete("inv:" + t); await this.st.put("invites", (await this.cleanInvites()).filter(x => x !== t));
    return json({ ok: true, claimed: true, fresh: true, role: "user", name: inv.name, prog: inv.prog || null });
  }
  async users() {
    const users = (await this.st.get("users")) || {}, out = [];
    for (const h of Object.keys(users)) {
      let m = null; try { m = (await this.inner(h, "/_meta")).latest || null; } catch (e) {}
      out.push({ id: users[h].id, name: users[h].name, t: users[h].t, seen: users[h].seen || null, latest: m });
    }
    out.sort((x, y) => x.t - y.t);
    const inv = [];
    for (const t of await this.cleanInvites()) { const v = await this.st.get("inv:" + t); inv.push({ invite: t, name: v.name, exp: v.exp, prog: !!v.prog }); }
    return { ok: true, users: out, invites: inv };
  }
  async delUser(b) {
    const users = (await this.st.get("users")) || {}, h = Object.keys(users).find(k => users[k].id === b.id);
    if (!h) return { ok: false, error: "no user" };
    try { await this.inner(h, "/_wipe"); } catch (e) {}
    delete users[h]; await this.st.put("users", users);
    return { ok: true };
  }
  async internal(p, b) {
    if (p === "/_init") {
      if (await this.st.get("owner")) return { ok: false, error: "exists" };
      await this.st.put({ owner: b.owner, isUser: true, name: b.name || "", vapid: b.vapid });
      return { ok: true };
    }
    if (p === "/_meta") return { ok: true, latest: (await this.st.get("m:latest")) || null };
    if (p === "/_wipe") { await this.st.deleteAlarm(); await this.st.deleteAll(); return { ok: true }; }
    return { ok: false, error: "not found" };
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
// redeploy 2026-11-13T07:13:56Z
