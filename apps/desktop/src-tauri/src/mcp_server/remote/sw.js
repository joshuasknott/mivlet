// Notification delivery only. No cached workspace data or offline task replay.
self.addEventListener("notificationclick",event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(async clients => {
    const existing=clients.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === "/remote");
    if (existing) return existing.focus();
    return self.clients.openWindow("/remote");
  }));
});
