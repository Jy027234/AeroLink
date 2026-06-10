// AeroLink Service Worker - Push Notification Support
// This SW handles push events and displays system notifications

const CACHE_NAME = 'aerolink-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text(), body: '' };
  }

  const title = payload.title || 'AeroLink';
  const options = {
    body: payload.body || '',
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    tag: payload.tag || 'aerolink-default',
    requireInteraction: payload.requireInteraction ?? false,
    data: payload.data || {},
    actions: payload.actions || [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const urlToOpen = notificationData.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(urlToOpen);
        }
      })
  );
});
