import { For, Show, createMemo } from "solid-js"
import { usePresence, type ActivityEvent, type ActivityType } from "@/context/presence"

function activityLabel(evt: ActivityEvent): string {
  const name = evt.peerName
  switch (evt.type) {
    case "join":
      return `${name} joined`
    case "leave":
      return `${name} left`
    case "typing":
      return `${name} started typing`
    case "cursor":
      if (evt.data?.area === "prompt") return `${name} is in prompt`
      if (evt.data?.area === "message-timeline") return `${name} is reading messages`
      if (evt.data?.area === "terminal") return `${name} is in terminal`
      if (evt.data?.area === "file-tree") return `${name} is browsing files`
      if (evt.data?.area === "review") return `${name} is reviewing changes`
      return `${name} moved`
    case "file":
      return `${name} opened ${evt.data?.file}`
    case "message":
      return `${name} sent a message`
    case "mention":
      return `${name} mentioned you`
    default:
      return `${name} was active`
  }
}

function activityIcon(type: ActivityType): string {
  switch (type) {
    case "join":
      return "→"
    case "leave":
      return "←"
    case "typing":
      return "…"
    case "cursor":
      return "◎"
    case "file":
      return "📄"
    case "message":
      return "💬"
    case "mention":
      return "@"
    default:
      return "•"
  }
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return "now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

export function ActivityTimeline() {
  const presence = usePresence()

  const sortedActivities = createMemo(() => {
    return [...presence.activities()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 15)
  })

  return (
    <Show when={sortedActivities().length > 0}>
      <div class="flex flex-col gap-0.5 py-1">
        <For each={sortedActivities()}>
          {(evt) => (
            <div class="flex items-center gap-2 px-3 py-1 text-11-regular hover:bg-surface-raised-base-hover rounded-md mx-1">
              <span
                class="size-4 rounded-full flex items-center justify-center text-[10px] shrink-0"
                style={{ "background-color": evt.peerColor, color: "#fff" }}
              >
                {activityIcon(evt.type)}
              </span>
              <span class="text-text-muted truncate flex-1">{activityLabel(evt)}</span>
              <span class="text-text-weak shrink-0 text-[10px]">{formatTimeAgo(evt.timestamp)}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
