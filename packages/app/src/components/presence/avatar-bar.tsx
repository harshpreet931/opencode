import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { usePresence } from "@/context/presence"
import { PresenceNameDialog } from "./name-dialog"

const MAX_VISIBLE = 3

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function Avatar(props: {
  name: string
  color: string
  bold?: boolean
  pulse?: boolean
  ring?: boolean
  onClick?: () => void
  title?: string
}) {
  return (
    <div
      class="-ml-1.5 first:ml-0 size-6 rounded-full flex items-center justify-center text-[10px] ring-2 ring-background-base shrink-0 transition-all duration-150 select-none"
      classList={{
        "font-bold cursor-pointer hover:scale-110 hover:z-10": props.bold,
        "font-medium": !props.bold,
        "animate-pulse": !!props.pulse,
      }}
      style={{
        "background-color": props.color,
        color: "#fff",
        ...(props.ring ? { "--tw-ring-color": props.color } : {}),
      }}
      title={props.title}
      onClick={props.onClick}
    >
      {initials(props.name)}
    </div>
  )
}

export function AvatarBar() {
  const presence = usePresence()
  const [showNameDialog, setShowNameDialog] = createSignal(false)
  const [showDropdown, setShowDropdown] = createSignal(false)

  createEffect(
    on(
      () => presence.connected(),
      (connected) => {
        if (connected && !presence.hasName()) setShowNameDialog(true)
      },
    ),
  )

  const visible = createMemo(() => presence.peers().slice(0, MAX_VISIBLE))
  const overflow = createMemo(() => presence.peers().slice(MAX_VISIBLE))

  return (
    <Show when={presence.connected()}>
      <div class="relative flex items-center px-2">
        {/* Stack: local peer first, always shown */}
        <Show when={presence.localPeer()}>
          {(peer) => (
            <Avatar
              name={peer().name}
              color={peer().color}
              bold
              ring
              title={`${peer().name} (you) — click to change name`}
              onClick={() => setShowNameDialog(true)}
            />
          )}
        </Show>

        {/* Up to MAX_VISIBLE remote peers */}
        <For each={visible()}>
          {(peer) => (
            <Avatar
              name={peer.name}
              color={peer.color}
              pulse={peer.isTyping}
              title={peer.name + (peer.isTyping ? " (typing…)" : "")}
            />
          )}
        </For>

        {/* Overflow pill */}
        <Show when={overflow().length > 0}>
          <button
            class="-ml-1.5 size-6 rounded-full flex items-center justify-center text-[9px] font-semibold bg-surface-raised-base ring-2 ring-background-base text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-all shrink-0 cursor-pointer"
            title={`${overflow().length} more`}
            onClick={() => setShowDropdown((v) => !v)}
          >
            +{overflow().length}
          </button>
        </Show>

        {/* Dropdown */}
        <Show when={showDropdown()}>
          {/* backdrop */}
          <div class="fixed inset-0 z-[9998]" onClick={() => setShowDropdown(false)} />
          <div class="absolute right-0 top-8 z-[9999] min-w-[160px] bg-surface-base border border-border-base rounded-lg shadow-lg py-1 flex flex-col">
            <Show when={presence.localPeer()}>
              {(peer) => (
                <div
                  class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-raised-base-hover cursor-pointer"
                  onClick={() => {
                    setShowDropdown(false)
                    setShowNameDialog(true)
                  }}
                >
                  <div
                    class="size-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold ring-1"
                    style={{ "background-color": peer().color, color: "#fff", "--tw-ring-color": peer().color }}
                  >
                    {initials(peer().name)}
                  </div>
                  <span class="text-12-regular text-text-base truncate" title={peer().name}>
                    {peer().name}
                  </span>
                  <span class="text-10-regular text-text-weak ml-auto">you</span>
                </div>
              )}
            </Show>
            <For each={presence.peers()}>
              {(peer) => (
                <div class="flex items-center gap-2 px-3 py-1.5">
                  <div
                    class="size-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-medium"
                    classList={{ "animate-pulse": peer.isTyping }}
                    style={{ "background-color": peer.color, color: "#fff" }}
                  >
                    {initials(peer.name)}
                  </div>
                  <span class="text-12-regular text-text-base truncate" title={peer.name}>
                    {peer.name}
                  </span>
                  <Show when={peer.isTyping}>
                    <span class="text-10-regular text-text-weak ml-auto">typing…</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <PresenceNameDialog open={showNameDialog()} onClose={() => setShowNameDialog(false)} />
    </Show>
  )
}
