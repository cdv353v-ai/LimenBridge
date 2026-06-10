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
