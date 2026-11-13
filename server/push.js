// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) on WebCrypto — no dependencies.
const te = new TextEncoder();
export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function cat(...arr) { let n = 0; arr.forEach(a => n += a.length); const o = new Uint8Array(n); let p = 0; arr.forEach(a => { o.set(a, p); p += a.length; }); return o; }
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// opts.asKeys = {pub: Uint8Array(65), priv: CryptoKey}, opts.salt — only for tests
export async function encrypt(plain, p256dh, auth, opts = {}) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  let asPub, asPriv;
  if (opts.asKeys) { asPub = opts.asKeys.pub; asPriv = opts.asKeys.priv; }
  else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); asPriv = kp.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const ikm = await hkdf(secret, ecdh, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = typeof plain === "string" ? te.encode(plain) : plain;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(body, new Uint8Array([2]))));
  const rs = 4096, head = new Uint8Array(21);
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, rs); head[20] = 65;
  return cat(head, asPub, ct);
}
export async function newVapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}
export async function vapidAuth(endpoint, vapid, sub) {
  const aud = new URL(endpoint).origin;
  const h = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const key = await crypto.subtle.importKey("jwk", vapid.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(h + "." + c));
  return "vapid t=" + h + "." + c + "." + b64u(sig) + ", k=" + vapid.pub;
}
export async function sendPush(subscription, payload, vapid, subject, fetchFn = fetch) {
  const body = await encrypt(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
  return fetchFn(subscription.endpoint, {
    method: "POST",
    headers: { Authorization: await vapidAuth(subscription.endpoint, vapid, subject), TTL: "300", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Topic: "rest" },
    body
  });
}
