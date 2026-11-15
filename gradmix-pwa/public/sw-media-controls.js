// Manejador local de controles multimedia en la barra de notificaciones (sin VAPID)
self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'focus';

  if (action === 'close') {
    event.notification.close();
    return;
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          client.postMessage({
            type: 'gradmix-media-action',
            action,
          });
        }
        if (action === 'focus' && clientList.length > 0 && 'focus' in clientList[0]) {
          return clientList[0].focus();
        }
      })
  );
});
