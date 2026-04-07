import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { usePresence } from "@/context/presence"
import { PresenceNameDialog } from "./name-dialog"
import { ActivityTimeline } from "./activity-timeline"

const MAX_VISIBLE = 3

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function sinceConnected(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return "just joined"
  if (mins === 1) return "1 min ago"
  if (mins < 60) return `${mins} mins ago`
  const hrs = Math.floor(mins / 60)
  return hrs === 1 ? "1 hr ago" : `${hrs} hrs ago`
}

type PeerDetail = {
  name: string
  color: string
  browser?: string
  connectedAt?: number
  isTyping?: boolean
  isLocal?: boolean
}

function PeerModal(props: { peer: PeerDetail; onClose: () => void; onChangeName: () => void }) {
  return (
    <div class="fixed inset-0 z-[10000] flex items-end sm:items-center justify-center" onClick={props.onClose}>
      <div class="absolute inset-0 bg-black/40" />
      <div
        class="relative w-full sm:w-auto sm:min-w-[300px] bg-surface-base border border-border-base rounded-t-2xl sm:rounded-2xl shadow-xl p-5 flex flex-col gap-3 sm:max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center gap-3">
          <div
            class="size-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0"
            classList={{ "animate-pulse": !!props.peer.isTyping }}
            style={{ "background-color": props.peer.color, color: "#fff" }}
          >
            {initials(props.peer.name)}
          </div>
          <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-14-regular font-semibold text-text-strong truncate">{props.peer.name}</span>
              <Show when={props.peer.isLocal}>
                <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-surface-raised-base text-text-weak shrink-0">
                  you
                </span>
              </Show>
            </div>
            <Show when={props.peer.isTyping}>
              <span class="text-11-regular text-text-weak">typing…</span>
            </Show>
          </div>
        </div>

        {/* Details */}
        <div class="flex flex-col gap-1.5 border-t border-border-base pt-3">
          <Show when={props.peer.browser}>
            <div class="flex items-center justify-between text-12-regular">
              <span class="text-text-weak">Browser</span>
              <span class="text-text-base font-medium">{props.peer.browser}</span>
            </div>
          </Show>
          <Show when={props.peer.connectedAt !== undefined}>
            <div class="flex items-center justify-between text-12-regular">
              <span class="text-text-weak">Joined</span>
              <span class="text-text-base font-medium">{sinceConnected(props.peer.connectedAt!)}</span>
            </div>
          </Show>
        </div>

        {/* Actions */}
        <div class="flex flex-col gap-2 pt-1">
          <Show when={props.peer.isLocal}>
            <button
              class="py-2 rounded-lg bg-surface-raised-base hover:bg-surface-raised-base-hover text-12-regular text-text-base transition-colors"
              onClick={() => {
                props.onClose()
                props.onChangeName()
              }}
            >
              Change display name
            </button>
          </Show>
          <button
            class="py-2 rounded-lg border border-border-base text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
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
        "font-bold cursor-pointer hover:scale-110 hover:z-10": props.bold || !!props.onClick,
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
  const [modal, setModal] = createSignal<PeerDetail | null>(null)

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
              title={[`${peer().name} (you)`, peer().browser, "click to change name"].filter(Boolean).join(" · ")}
              onClick={() =>
                setModal({ name: peer().name, color: peer().color, browser: peer().browser, isLocal: true })
              }
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
              title={[peer.name + (peer.isTyping ? " (typing…)" : ""), peer.browser, sinceConnected(peer.connectedAt)]
                .filter(Boolean)
                .join(" · ")}
              onClick={() =>
                setModal({
                  name: peer.name,
                  color: peer.color,
                  browser: peer.browser,
                  connectedAt: peer.connectedAt,
                  isTyping: peer.isTyping,
                })
              }
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
                  <div class="flex flex-col min-w-0">
                    <span class="text-12-regular text-text-base truncate" title={peer().name}>
                      {peer().name}
                    </span>
                    <Show when={peer().browser}>
                      <span class="text-10-regular text-text-weak truncate">{peer().browser}</span>
                    </Show>
                  </div>
                  <span class="text-10-regular text-text-weak ml-auto shrink-0">you</span>
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
                  <div class="flex flex-col min-w-0">
                    <span class="text-12-regular text-text-base truncate" title={peer.name}>
                      {peer.name}
                    </span>
                    <span class="text-10-regular text-text-weak truncate">
                      {[peer.browser, sinceConnected(peer.connectedAt)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <Show when={peer.isTyping}>
                    <span class="text-10-regular text-text-weak ml-auto shrink-0">typing…</span>
                  </Show>
                </div>
              )}
            </For>
            <div class="border-t border-border-base mt-1 pt-1">
              <div class="px-3 py-1 text-[10px] font-medium text-text-weak uppercase tracking-wide">
                Recent Activity
              </div>
              <ActivityTimeline />
            </div>
          </div>
        </Show>
      </div>

      {/* Peer detail modal (long press) */}
      <Show when={modal()}>
        {(peer) => (
          <PeerModal peer={peer()} onClose={() => setModal(null)} onChangeName={() => setShowNameDialog(true)} />
        )}
      </Show>

      <PresenceNameDialog open={showNameDialog()} onClose={() => setShowNameDialog(false)} />
    </Show>
  )
}
