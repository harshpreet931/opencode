import { createEffect, createSignal, For, on, Show } from "solid-js"
import { usePresence } from "@/context/presence"
import { PresenceNameDialog } from "./name-dialog"

function initials(name: string) {
  const parts = name.split(" ")
  return parts
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function AvatarBar() {
  const presence = usePresence()
  const [showNameDialog, setShowNameDialog] = createSignal(false)

  // Show name dialog on first connection if no saved name
  createEffect(
    on(
      () => presence.connected(),
      (connected) => {
        if (connected && !presence.hasName()) {
          setShowNameDialog(true)
        }
      },
    ),
  )

  return (
    <Show when={presence.connected()}>
      <div class="flex items-center gap-1 px-2">
        {/* Local peer avatar - clickable to change name */}
        <Show when={presence.localPeer()}>
          {(peer) => (
            <div
              class="size-6 rounded-full flex items-center justify-center text-[10px] font-medium ring-2 ring-background-base shrink-0 cursor-pointer hover:ring-blue-400 transition-all"
              style={{ "background-color": peer().color, color: "#fff" }}
              title={`${peer().name} (you) — click to change name`}
              onClick={() => setShowNameDialog(true)}
            >
              {initials(peer().name)}
            </div>
          )}
        </Show>
        {/* Remote peer avatars */}
        <For each={presence.peers()}>
          {(peer) => (
            <div
              class="size-6 rounded-full flex items-center justify-center text-[10px] font-medium ring-2 ring-background-base shrink-0 transition-all duration-200"
              classList={{ "animate-pulse": peer.isTyping }}
              style={{ "background-color": peer.color, color: "#fff" }}
              title={peer.name}
            >
              {initials(peer.name)}
            </div>
          )}
        </For>
        <Show when={presence.peerCount() > 0}>
          <span class="text-11-regular text-text-weak ml-1">
            {presence.peerCount()} {presence.peerCount() === 1 ? "viewer" : "viewers"}
          </span>
        </Show>
      </div>
      <PresenceNameDialog open={showNameDialog()} onClose={() => setShowNameDialog(false)} />
    </Show>
  )
}
