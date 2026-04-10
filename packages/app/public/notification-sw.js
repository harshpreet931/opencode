self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const href = event.notification.data?.href
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const client = list[0]
      if (client) {
        if (href && "navigate" in client) {
          await client.navigate(href).catch(() => undefined)
        }
        await client.focus().catch(() => undefined)
        return
      }
      if (href) {
        await self.clients.openWindow(href).catch(() => undefined)
      }
    })(),
  )
})
