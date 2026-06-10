importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBP1VOwZt1hOPqFd0HY96x6ipLWa1TGPeg",
  authDomain: "limenbridge.firebaseapp.com",
  projectId: "limenbridge",
  storageBucket: "limenbridge.firebasestorage.app",
  messagingSenderId: "795817059671",
  appId: "1:795817059671:web:e40d740c68e984be608a12"
});

const messaging = firebase.messaging();

const CACHE = 'limenbridge-v1';
const STATIC = ['/', '/index.html', '/icon-192.png', '/icon-512.png'];

// Install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Background push notifications (when site is closed)
messaging.onBackgroundMessage(payload => {
  const { title, body, url } = payload.data || {};
  self.registration.showNotification(title || 'LimenBridge', {
    body: body || 'Your track is ready.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: url || '/' },
    vibrate: [100, 50, 100]
  });
});

// Notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('limenbridge.cc'));
      if (existing) return existing.focus();
      return clients.openWindow(e.notification.data?.url || '/');
    })
  );
});
