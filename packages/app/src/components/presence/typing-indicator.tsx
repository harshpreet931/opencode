import { For, Show, createMemo } from "solid-js"
import { usePresence } from "@/context/presence"

export function TypingIndicator() {
  const presence = usePresence()

  const typingPeers = createMemo(() => presence.peers().filter((p) => p.isTyping))

  const label = createMemo(() => {
    const tp = typingPeers()
    if (tp.length === 0) return ""
    if (tp.length === 1) return `${tp[0].name} is typing...`
    if (tp.length === 2) return `${tp[0].name} and ${tp[1].name} are typing...`
    return `${tp[0].name} and ${tp.length - 1} others are typing...`
  })

  return (
    <Show when={typingPeers().length > 0}>
      <div class="flex items-center gap-1.5 px-3 py-1 text-11-regular text-text-weak">
        <div class="flex gap-0.5">
          <For each={typingPeers().slice(0, 3)}>
            {(peer) => (
              <div
                class="size-1.5 rounded-full animate-pulse"
                style={{ "background-color": peer.color }}
              />
            )}
          </For>
        </div>
        <span>{label()}</span>
      </div>
    </Show>
  )
}
