import { For, Show, createMemo } from "solid-js"
import { usePresence } from "@/context/presence"

interface Props {
  scrollerRef: HTMLElement | undefined
}

export function ScrollIndicators(props: Props) {
  const presence = usePresence()

  const timelinePeers = createMemo(() =>
    presence.peers().filter((p) => p.cursor?.area === "message-timeline" && p.cursor.scrollY !== undefined),
  )

  return (
    <Show when={props.scrollerRef && timelinePeers().length > 0}>
      <div class="absolute right-0 top-0 bottom-0 w-2 pointer-events-none z-40">
        <For each={timelinePeers()}>
          {(peer) => (
            <div
              class="absolute right-0.5 size-1.5 rounded-full transition-all duration-300"
              style={{
                "background-color": peer.color,
                top: `${(peer.cursor!.scrollY! * 100).toFixed(1)}%`,
              }}
              title={peer.name}
            />
          )}
        </For>
      </div>
    </Show>
  )
}
