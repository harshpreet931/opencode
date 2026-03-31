import { For, Show, createMemo } from "solid-js"
import { Portal } from "solid-js/web"
import { usePresence } from "@/context/presence"

const STALE_MS = 3000

export function MouseCursors() {
  const presence = usePresence()

  const activePeers = createMemo(() => {
    const now = Date.now()
    return presence.peers().filter((p) => p.mouse && now - p.mouse.lastUpdate < STALE_MS)
  })

  return (
    <Portal>
      <div class="fixed inset-0 pointer-events-none" style={{ "z-index": "9999" }}>
        <For each={activePeers()}>
          {(peer) => (
            <Show when={peer.mouse}>
              {(mouse) => (
                <div
                  class="absolute transition-all duration-75 ease-out"
                  style={{
                    left: `${mouse().x * 100}%`,
                    top: `${mouse().y * 100}%`,
                  }}
                >
                  {/* Cursor SVG */}
                  <svg
                    width="16"
                    height="20"
                    viewBox="0 0 16 20"
                    fill="none"
                    style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }}
                  >
                    <path
                      d="M0.5 0.5L15 11.5H7L3.5 19.5L0.5 0.5Z"
                      fill={peer.color}
                      stroke="white"
                      stroke-width="1"
                    />
                  </svg>
                  {/* Name label */}
                  <div
                    class="absolute left-4 top-4 px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap shadow-sm"
                    style={{
                      "background-color": peer.color,
                      color: "#fff",
                    }}
                  >
                    {peer.name}
                  </div>
                </div>
              )}
            </Show>
          )}
        </For>
      </div>
    </Portal>
  )
}
