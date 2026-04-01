import { For, Show, createMemo } from "solid-js"
import { usePresence } from "@/context/presence"

export function PeerInputPreview() {
  const presence = usePresence()
  const typing = createMemo(() => presence.peers().filter((p) => p.isTyping))

  return (
    <Show when={typing().length > 0}>
      <div
        class="flex flex-col border-b border-border-base overflow-hidden"
        style={{ transition: "max-height 0.2s ease, opacity 0.2s ease" }}
      >
        <For each={typing()}>
          {(peer) => {
            const text = () => peer.input?.text ?? ""
            const pos = () => peer.input?.cursorPosition
            const before = () =>
              pos() !== undefined ? text().slice(0, Math.min(pos()!, 110)) : text().slice(0, 110)
            const after = () => (pos() !== undefined ? text().slice(pos()!, 110) : "")
            const hasText = () => text().length > 0

            return (
              <div class="presence-row flex items-center gap-2 px-3 py-1.5 text-11-regular min-w-0">
                <div
                  class="size-1.5 rounded-full shrink-0"
                  style={{ "background-color": peer.color, opacity: "0.9" }}
                />
                <span class="font-semibold shrink-0 mr-0.5" style={{ color: peer.color }}>
                  {peer.name}
                </span>
                <Show
                  when={hasText()}
                  fallback={
                    <div class="flex gap-1 items-center" style={{ "padding-top": "1px" }}>
                      <div class="presence-dot size-1 rounded-full" style={{ "background-color": peer.color, "animation-delay": "0ms" }} />
                      <div class="presence-dot size-1 rounded-full" style={{ "background-color": peer.color, "animation-delay": "200ms" }} />
                      <div class="presence-dot size-1 rounded-full" style={{ "background-color": peer.color, "animation-delay": "400ms" }} />
                    </div>
                  }
                >
                  <span
                    class="text-text-muted italic truncate"
                    style={{ opacity: "0.55", transition: "opacity 0.15s ease" }}
                  >
                    {before()}
                    <span
                      class="inline-block w-px h-[11px] rounded-full align-middle mx-px"
                      style={{
                        "background-color": peer.color,
                        animation: "pulse 1s ease-in-out infinite",
                        opacity: "0.8",
                      }}
                    />
                    {after()}
                    {text().length > 110 ? "…" : ""}
                  </span>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
