import { For, createMemo } from "solid-js"
import { usePresence } from "@/context/presence"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props {
  editorRef: HTMLElement | undefined
}

export function RemoteCursors(_props: Props) {
  const presence = usePresence()

  const promptPeers = createMemo(() =>
    presence.peers().filter((p) => p.cursor?.area === "prompt"),
  )

  return (
    <For each={promptPeers()}>
      {(peer) => (
        <div
          class="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium pointer-events-none"
          style={{ color: peer.color }}
        >
          <div
            class="size-1.5 rounded-full animate-pulse"
            style={{ "background-color": peer.color }}
          />
          <span>
            {peer.name}
            {peer.isTyping ? " is typing here..." : " is here"}
          </span>
        </div>
      )}
    </For>
  )
}
