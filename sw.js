/* GutCheck service worker — offline app shell + PWA installability.
   Same-origin GETs: network-first, cache as offline fallback.
   Cross-origin (Firebase, Anthropic, Deepgram, xAI): always network. */
const CACHE = "gutcheck-v61";
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "js/social.js", "js/nav.js", "js/logo.js", "manifest.json"];

/* ---------- push notifications (FCM background handler) ----------
   Fires when a push arrives while the app is backgrounded or fully closed —
   foreground messages are handled in social.js instead (banner UI). */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBrU3858Blfz8om6jzz91JWF1FODcVkMhA",
  authDomain: "gutcheck-efc9a.firebaseapp.com",
  projectId: "gutcheck-efc9a",
  storageBucket: "gutcheck-efc9a.firebasestorage.app",
  messagingSenderId: "149877550947",
  appId: "1:149877550947:web:70e746055301b932212d56",
});

try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    const data = payload.data || {};
    self.registration.showNotification(n.title || "GutCheck", {
      body: n.body || "",
      icon: "icon-192.jpg",
      badge: "icon-192.jpg",
      tag: data.tag || "gutcheck",
      data,
    });
  });
} catch (e) { /* messaging unsupported in this browser's SW context — cache/PWA still work fine */ }

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || "./";
  // deep-link into the sender's conversation; if the app is already open,
  // message it instead of opening a duplicate tab
  const deepLink = data.fromUid ? url.split("#")[0] + "#convo=" + encodeURIComponent(data.fromUid) : url;
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.focus();
          if (data.fromUid) c.postMessage({ type: "gc-open-convo", uid: data.fromUid });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(deepLink);
    })
  );
});

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // APIs & Firebase go straight to network
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});
