import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServer } from "./server"
import { decode64 } from "@/utils/base64"

// ── Types ─────────────────────────────────────────────────

export type CursorArea = "prompt" | "message-timeline" | "terminal" | "file-tree" | "review" | "idle"

export interface CursorState {
  area: CursorArea
  position?: number
  selection?: { start: number; end: number }
  scrollY?: number
  messageID?: string
}

export interface PeerInfo {
  id: string
  name: string
  color: string
  connectedAt: number
  cursor?: CursorState
  isTyping: boolean
}

export interface PeerInputSnapshot {
  text: string
  cursorPosition?: number
}

export interface PeerMouse {
  x: number
  y: number
  lastUpdate: number
}

export interface PeerState extends PeerInfo {
  input?: PeerInputSnapshot
  mouse?: PeerMouse
}

export interface RecentStop {
  peer: PeerState
  time: number
}

// ── Server Messages ───────────────────────────────────────

type ServerMessage =
  | { type: "welcome"; peer: PeerInfo; peers: PeerInfo[] }
  | { type: "peer.joined"; peer: PeerInfo }
  | { type: "peer.left"; peerID: string }
  | { type: "peer.cursor"; peerID: string; cursor: CursorState }
  | { type: "peer.input"; peerID: string; text: string; cursorPosition?: number }
  | { type: "peer.typing"; peerID: string; isTyping: boolean }
  | { type: "peer.mouse"; peerID: string; x: number; y: number }
  | { type: "peer.name"; peerID: string; name: string }
  | { type: "pong" }

// ── Client Messages ───────────────────────────────────────

type ClientMessage =
  | {
      type: "cursor"
      area: CursorArea
      position?: number
      selection?: { start: number; end: number }
      scrollY?: number
      messageID?: string
    }
  | { type: "input"; text: string; cursorPosition?: number }
  | { type: "typing"; isTyping: boolean }
  | { type: "mouse"; x: number; y: number }
  | { type: "name"; name: string }
  | { type: "ping" }

// ── Constants ─────────────────────────────────────────────

const CURSOR_THROTTLE_MS = 50
const INPUT_THROTTLE_MS = 200
const PING_INTERVAL_MS = 10_000
const RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
const PRESENCE_NAME_KEY = "opencode.presence.name"

// ── Context ───────────────────────────────────────────────

export const { use: usePresence, provider: PresenceProvider } = createSimpleContext({
  name: "Presence",
  gate: false,
  init: () => {
    const params = useParams()
    const server = useServer()

    const [localPeer, setLocalPeer] = createSignal<PeerInfo | null>(null)
    const [store, setStore] = createStore<{ peers: Record<string, PeerState> }>({ peers: {} })
    const [connected, setConnected] = createSignal(false)
    const [recentStops, setRecentStops] = createSignal<RecentStop[]>([])

    let ws: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectDelay = RECONNECT_DELAY_MS
    let lastCursorSend = 0
    let lastInputSend = 0
    let pendingCursor: ClientMessage | null = null
    let pendingInput: ClientMessage | null = null
    let cursorTimer: ReturnType<typeof setTimeout> | undefined
    let inputTimer: ReturnType<typeof setTimeout> | undefined

    // ── WebSocket URL ──

    function wsUrl(sessionID: string): string {
      const http = server.current?.http
      if (!http) throw new Error("No server connection")
      const base = new URL(http.url)
      base.protocol = base.protocol === "https:" ? "wss:" : "ws:"
      base.pathname = `/presence/${encodeURIComponent(sessionID)}`
      if (http.password) {
        base.username = http.username ?? "opencode"
        base.password = http.password
      }
      const directory = decode64(params.dir)
      if (directory) {
        base.searchParams.set("directory", directory)
      }
      return base.toString()
    }

    // ── Connection ──

    function connect() {
      const sessionID = params.id
      if (!sessionID || !server.current) {
        console.warn("[presence] skipping connect: no sessionID or server", { sessionID, hasCurrent: !!server.current })
        return
      }

      let url: string
      try {
        url = wsUrl(sessionID)
        console.log("[presence] connecting to", url)
        ws = new WebSocket(url)
      } catch (e) {
        console.error("[presence] failed to create WebSocket", e)
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        console.log("[presence] connected")
        setConnected(true)
        reconnectDelay = RECONNECT_DELAY_MS
        pingTimer = setInterval(() => {
          sendMessage({ type: "ping" })
        }, PING_INTERVAL_MS)
      }

      ws.onmessage = (event) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        console.log("[presence] received", msg.type)
        handleMessage(msg)
      }

      ws.onclose = (e) => {
        console.warn("[presence] closed", e.code, e.reason)
        cleanup()
        scheduleReconnect()
      }

      ws.onerror = (e) => {
        console.error("[presence] error", e)
        cleanup()
        scheduleReconnect()
      }
    }

    function cleanup() {
      setConnected(false)
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = undefined
      ws = null
    }

    function disconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = undefined
      if (inputTimer) clearTimeout(inputTimer)
      inputTimer = undefined
      if (ws) {
        ws.onclose = null
        ws.close()
      }
      cleanup()
      setLocalPeer(null)
      setStore("peers", {})
    }

    function scheduleReconnect() {
      if (reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS)
        connect()
      }, reconnectDelay)
    }

    // ── Message Handling ──

    function handleMessage(msg: ServerMessage) {
      switch (msg.type) {
        case "welcome": {
          // If user has a saved name, send it immediately
          const savedName = localStorage.getItem(PRESENCE_NAME_KEY)
          if (savedName && savedName !== msg.peer.name) {
            msg.peer = { ...msg.peer, name: savedName }
            sendMessage({ type: "name", name: savedName })
          }
          setLocalPeer(msg.peer)
          batch(() => {
            const peers: Record<string, PeerState> = {}
            for (const p of msg.peers) {
              peers[p.id] = { ...p, input: undefined }
            }
            setStore("peers", peers)
          })
          break
        }
        case "peer.joined": {
          setStore("peers", msg.peer.id, { ...msg.peer, input: undefined })
          break
        }
        case "peer.left": {
          setStore(
            produce((s) => {
              delete s.peers[msg.peerID]
            }),
          )
          break
        }
        case "peer.cursor": {
          setStore("peers", msg.peerID, "cursor", msg.cursor)
          break
        }
        case "peer.input": {
          setStore("peers", msg.peerID, "input", {
            text: msg.text,
            cursorPosition: msg.cursorPosition,
          })
          break
        }
        case "peer.typing": {
          const wasTyping = store.peers[msg.peerID]?.isTyping
          setStore("peers", msg.peerID, "isTyping", msg.isTyping)
          if (!wasTyping && msg.isTyping) {
            // Snapshot peer at the moment they START typing so attribution
            // is available even before they stop (race-free)
            const snap = store.peers[msg.peerID]
            if (snap) {
              const now = Date.now()
              setRecentStops((prev) => [
                { peer: { ...snap }, time: now },
                ...prev.filter((s) => now - s.time < 30_000),
              ])
            }
          }
          break
        }
        case "peer.mouse": {
          setStore("peers", msg.peerID, "mouse", {
            x: msg.x,
            y: msg.y,
            lastUpdate: Date.now(),
          })
          break
        }
        case "peer.name": {
          setStore("peers", msg.peerID, "name", msg.name)
          break
        }
        case "pong": {
          break
        }
      }
    }

    // ── Sending ──

    function sendMessage(msg: ClientMessage) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // connection closing
      }
    }

    function sendCursor(cursor: Omit<ClientMessage & { type: "cursor" }, "type">) {
      const msg: ClientMessage = { type: "cursor", ...cursor }
      const now = Date.now()
      const elapsed = now - lastCursorSend

      if (elapsed >= CURSOR_THROTTLE_MS) {
        sendMessage(msg)
        lastCursorSend = now
        pendingCursor = null
        if (cursorTimer) {
          clearTimeout(cursorTimer)
          cursorTimer = undefined
        }
      } else {
        pendingCursor = msg
        if (!cursorTimer) {
          cursorTimer = setTimeout(() => {
            cursorTimer = undefined
            if (pendingCursor) {
              sendMessage(pendingCursor)
              lastCursorSend = Date.now()
              pendingCursor = null
            }
          }, CURSOR_THROTTLE_MS - elapsed)
        }
      }
    }

    function sendInput(text: string, cursorPosition?: number) {
      const msg: ClientMessage = { type: "input", text, cursorPosition }
      const now = Date.now()
      const elapsed = now - lastInputSend

      if (elapsed >= INPUT_THROTTLE_MS) {
        sendMessage(msg)
        lastInputSend = now
        pendingInput = null
        if (inputTimer) {
          clearTimeout(inputTimer)
          inputTimer = undefined
        }
      } else {
        pendingInput = msg
        if (!inputTimer) {
          inputTimer = setTimeout(() => {
            inputTimer = undefined
            if (pendingInput) {
              sendMessage(pendingInput)
              lastInputSend = Date.now()
              pendingInput = null
            }
          }, INPUT_THROTTLE_MS - elapsed)
        }
      }
    }

    function sendTyping(isTyping: boolean) {
      sendMessage({ type: "typing", isTyping })
    }

    function setName(name: string) {
      const trimmed = name.trim()
      if (!trimmed) return
      localStorage.setItem(PRESENCE_NAME_KEY, trimmed)
      sendMessage({ type: "name", name: trimmed })
      setLocalPeer((prev) => (prev ? { ...prev, name: trimmed } : null))
    }

    const hasName = () => !!localStorage.getItem(PRESENCE_NAME_KEY)

    // ── Mouse tracking ──

    const MOUSE_THROTTLE_MS = 50
    let lastMouseSend = 0
    let pendingMouse: ClientMessage | null = null
    let mouseTimer: ReturnType<typeof setTimeout> | undefined

    function sendMouse(x: number, y: number) {
      const msg: ClientMessage = { type: "mouse", x, y }
      const now = Date.now()
      const elapsed = now - lastMouseSend

      if (elapsed >= MOUSE_THROTTLE_MS) {
        sendMessage(msg)
        lastMouseSend = now
        pendingMouse = null
        if (mouseTimer) {
          clearTimeout(mouseTimer)
          mouseTimer = undefined
        }
      } else {
        pendingMouse = msg
        if (!mouseTimer) {
          mouseTimer = setTimeout(() => {
            mouseTimer = undefined
            if (pendingMouse) {
              sendMessage(pendingMouse)
              lastMouseSend = Date.now()
              pendingMouse = null
            }
          }, MOUSE_THROTTLE_MS - elapsed)
        }
      }
    }

    // Track mouse movement on the page
    const handleMouseMove = (e: MouseEvent) => {
      // Send as percentage of viewport so it works across different screen sizes
      const x = e.clientX / window.innerWidth
      const y = e.clientY / window.innerHeight
      sendMouse(x, y)
    }

    document.addEventListener("mousemove", handleMouseMove)
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove)
      if (mouseTimer) clearTimeout(mouseTimer)
    })

    // ── Lifecycle ──

    const sessionID = createMemo(() => params.id)

    console.log("[presence] init, params.id =", params.id, "server.current =", !!server.current)

    createEffect(
      on(sessionID, (id, prev) => {
        console.log("[presence] sessionID changed:", { id, prev })
        if (prev) disconnect()
        if (id) connect()
      }),
    )

    onCleanup(disconnect)

    // ── Public API ──

    const peers = createMemo(() => Object.values(store.peers))
    const peerCount = createMemo(() => Object.keys(store.peers).length)

    return {
      localPeer,
      peers,
      peerCount,
      connected,
      recentStops,
      peer: (id: string) => store.peers[id] as PeerState | undefined,
      sendCursor,
      sendInput,
      sendTyping,
      sendMouse,
      setName,
      hasName,
    }
  },
})
