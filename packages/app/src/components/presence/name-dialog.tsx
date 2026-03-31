import { createSignal, Show } from "solid-js"
import { usePresence } from "@/context/presence"

export function PresenceNameDialog(props: { open: boolean; onClose: () => void }) {
  const presence = usePresence()
  const [value, setValue] = createSignal(presence.localPeer()?.name ?? "")

  const save = () => {
    const name = value().trim()
    if (name) {
      presence.setName(name)
      props.onClose()
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
    }
    if (e.key === "Escape") {
      props.onClose()
    }
  }

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[10000] flex items-center justify-center" onClick={() => props.onClose()}>
        {/* Backdrop */}
        <div class="absolute inset-0 bg-black/40" />
        {/* Dialog */}
        <div
          class="relative bg-surface-base border border-border-base rounded-lg shadow-lg p-5 w-[340px] flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex flex-col gap-1">
            <h3 class="text-14-regular font-semibold text-text-strong">Set your display name</h3>
            <p class="text-12-regular text-text-weak">
              This name will be visible to others in the session.
            </p>
          </div>
          <input
            type="text"
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your name..."
            maxLength={30}
            autofocus
            class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-panel text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-1 focus:ring-border-strong"
          />
          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => props.onClose()}
              class="px-3 py-1.5 rounded-md text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!value().trim()}
              class="px-3 py-1.5 rounded-md text-12-regular font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
