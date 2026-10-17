// Notification delivery only. No cached workspace data or offline task replay.
self.addEventListener("install",event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate",event => event.waitUntil(self.clients.claim()));
self.addEventListener("push",event => {
  // Native sends an empty signal. Never render data from a push endpoint.
  event.waitUntil(self.registration.showNotification("Mivlet", {
    body:"Shared work changed or needs your attention. Open Mivlet to review it.",
    tag:"mivlet-work-update",icon:"/remote/icon.png",data:{path:"/remote"}
  }));
});
self.addEventListener("notificationclick",event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(async clients => {
    const existing=clients.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === "/remote");
    if (existing) return existing.focus();
    return self.clients.openWindow("/remote");
  }));
});
