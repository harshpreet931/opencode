import { For, Show, createMemo } from "solid-js"
import { usePresence } from "@/context/presence"

export function PeerInputPreview() {
  const presence = usePresence()

  const peersWithInput = createMemo(() =>
    presence.peers().filter((p) => p.isTyping && p.input?.text),
  )

  return (
    <Show when={peersWithInput().length > 0}>
      <div class="flex flex-col gap-1 px-3 py-2 border-t border-border-base">
        <For each={peersWithInput()}>
          {(peer) => {
            const text = () => peer.input?.text ?? ""
            const cursorPos = () => peer.input?.cursorPosition
            const before = () => {
              const pos = cursorPos()
              if (pos === undefined) return text().slice(0, 200)
              return text().slice(0, Math.min(pos, 200))
            }
            const after = () => {
              const pos = cursorPos()
              if (pos === undefined) return ""
              return text().slice(pos, 200)
            }
            const truncated = () => text().length > 200

            return (
              <div class="flex items-start gap-2 text-12-regular">
                <div
                  class="size-2 rounded-full mt-1.5 shrink-0"
                  style={{ "background-color": peer.color }}
                />
                <div class="flex flex-col min-w-0">
                  <span class="text-text-weak text-11-regular">{peer.name}</span>
                  <span class="text-text-muted max-w-md opacity-60 italic whitespace-pre-wrap break-words">
                    {before()}
                    <span
                      class="inline-block w-0.5 h-3.5 rounded-full align-middle animate-pulse mx-px"
                      style={{ "background-color": peer.color }}
                    />
                    {after()}
                    {truncated() ? "..." : ""}
                  </span>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
