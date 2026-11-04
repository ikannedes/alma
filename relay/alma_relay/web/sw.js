// Service worker de la app de Alma: solo notificaciones (sin caché: los datos siempre son en vivo).
self.addEventListener("push", e => {
  let d = {title: "Alma", body: ""};
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Alma", {body: d.body || "", icon: "/icon.svg", tag: d.kind || "alma",
                                                                     data: {kind: d.kind, url: d.url}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  // "Ya jugué, te toca": directo a ese juego (/play/<juego>/); los demás abren la lista de avisos (dueño, 2026-11-01)
  const url = (e.notification.data || {}).url || "/?avisos";
  e.waitUntil(clients.matchAll({type: "window"}).then(ws => ws.length ? (ws[0].navigate(url), ws[0].focus()) : clients.openWindow(url)));
});
