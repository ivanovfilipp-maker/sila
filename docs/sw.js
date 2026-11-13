/* «Сила» service worker: works offline, shows the rest-timer push. */
var CACHE = "sila-1.7.0-3d4b8742";
var ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
function fromNet(req, ms) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error("slow")); }, ms);
    fetch(req, { cache: "no-store" }).then(function (r) { clearTimeout(t); if (r && r.ok) res(r); else rej(new Error("bad")); }, function (e) { clearTimeout(t); rej(e); });
  });
}
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  var page = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
  if (page) {
    // newest version when online (3 s budget), the saved copy otherwise
    e.respondWith(fromNet(req, 3000).then(function (r) { var c = r.clone(); caches.open(CACHE).then(function (ca) { ca.put("./index.html", c); }); return r; })
      .catch(function () { return caches.match("./index.html").then(function (r) { return r || caches.match("./"); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (r) { return r || fetch(req).then(function (n) { var c = n.clone(); caches.open(CACHE).then(function (ca) { ca.put(req, c); }); return n; }); }));
});
self.addEventListener("push", function (e) {
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { try { d = { body: e.data.text() }; } catch (y) {} }
  e.waitUntil(self.registration.showNotification(d.title || "Отдых окончен", { body: d.body || "Следующий подход", tag: d.tag || "sila-rest", renotify: true, icon: "./icon-192.png", badge: "./icon-192.png", data: { url: "./" } }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) { if ("focus" in cs[i]) return cs[i].focus(); }
    return self.clients.openWindow("./");
  }));
});
