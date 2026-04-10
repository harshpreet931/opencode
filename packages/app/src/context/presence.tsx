import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useSettings } from "./settings"
import { useServer } from "./server"
import { decode64 } from "@/utils/base64"
import { playSoundById } from "@/utils/sound"
import { handleNotificationClick } from "@/utils/notification-click"
import { getFilename } from "@opencode-ai/util/path"
import { base64Encode } from "@opencode-ai/util/encode"

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
  browser?: string
  scope?: "session" | "directory" | "global"
  directory?: string
  session_id?: string
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

export interface MentionEvent {
  from: PeerInfo
  text: string
  messageID?: string
  time: number
}

export type ActivityType = "join" | "leave" | "typing" | "cursor" | "file" | "message" | "mention"

export interface ActivityEvent {
  type: ActivityType
  peerID: string
  peerName: string
  peerColor: string
  timestamp: number
  data?: {
    area?: CursorArea
    file?: string
    messageID?: string
    text?: string
  }
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
  | { type: "peer.name"; peerID: string; name: string; color?: string }
  | { type: "peer.mention"; peerID: string; from: PeerInfo; text: string; messageID?: string; sessionID?: string }
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
  | { type: "name"; name: string; color?: string }
  | { type: "mention"; peerID: string; text: string; messageID?: string; sessionID?: string }
  | { type: "ping" }

// ── Constants ─────────────────────────────────────────────

const CURSOR_THROTTLE_MS = 50
const INPUT_THROTTLE_MS = 200
const PING_INTERVAL_MS = 10_000
const RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
const PRESENCE_NAME_KEY = "opencode.presence.name"
const PRESENCE_COLOR_KEY = "opencode.presence.color"

function detectBrowser(): string {
  const ua = navigator.userAgent
  let browser = "Browser"
  if (ua.includes("Edg/")) browser = "Edge"
  else if (ua.includes("Chrome/")) browser = "Chrome"
  else if (ua.includes("Firefox/")) browser = "Firefox"
  else if (ua.includes("Safari/")) browser = "Safari"
  let os = ""
  if (ua.includes("Android")) os = "Android"
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS"
  else if (ua.includes("Win")) os = "Windows"
  else if (ua.includes("Mac")) os = "macOS"
  else if (ua.includes("Linux")) os = "Linux"
  return os ? `${browser} on ${os}` : browser
}

// ── Context ───────────────────────────────────────────────

export const { use: usePresence, provider: PresenceProvider } = createSimpleContext({
  name: "Presence",
  gate: false,
  init: () => {
    const params = useParams()
    const language = useLanguage()
    const platform = usePlatform()
    const settings = useSettings()
    const server = useServer()

    const [sessionLocal, setSessionLocal] = createSignal<PeerInfo | null>(null)
    const [directoryLocal, setDirectoryLocal] = createSignal<PeerInfo | null>(null)
    const [globalLocal, setGlobalLocal] = createSignal<PeerInfo | null>(null)
    const [store, setStore] = createStore<{ peers: Record<string, PeerState> }>({ peers: {} })
    const [directoryStore, setDirectoryStore] = createStore<{ peers: Record<string, PeerState> }>({ peers: {} })
    const [globalStore, setGlobalStore] = createStore<{ peers: Record<string, PeerState> }>({ peers: {} })
    const [connected, setConnected] = createSignal(false)
    const [directoryConnected, setDirectoryConnected] = createSignal(false)
    const [globalConnected, setGlobalConnected] = createSignal(false)
    const [recentStops, setRecentStops] = createSignal<RecentStop[]>([])
    const [activities, setActivities] = createSignal<ActivityEvent[]>([])
    const [mentions, setMentions] = createSignal<MentionEvent[]>([])

    let ws: WebSocket | null = null
    let directoryWs: WebSocket | null = null
    let globalWs: WebSocket | null = null
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let directoryPingTimer: ReturnType<typeof setInterval> | undefined
    let globalPingTimer: ReturnType<typeof setInterval> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let directoryReconnectTimer: ReturnType<typeof setTimeout> | undefined
    let globalReconnectTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectDelay = RECONNECT_DELAY_MS
    let directoryReconnectDelay = RECONNECT_DELAY_MS
    let globalReconnectDelay = RECONNECT_DELAY_MS
    let lastCursorSend = 0
    let lastInputSend = 0
    let lastMouseSend = 0
    let pendingCursor: ClientMessage | null = null
    let pendingInput: ClientMessage | null = null
    let pendingMouse: ClientMessage | null = null
    let cursorTimer: ReturnType<typeof setTimeout> | undefined
    let inputTimer: ReturnType<typeof setTimeout> | undefined
    let mouseTimer: ReturnType<typeof setTimeout> | undefined

    const MAX_ACTIVITY_EVENTS = 50

    function logActivity(type: ActivityType, peerID: string, peer: PeerState, data?: ActivityEvent["data"]) {
      const now = Date.now()
      setActivities((prev: ActivityEvent[]) => {
        const newEvents = [
          {
            type,
            peerID,
            peerName: peer.name,
            peerColor: peer.color,
            timestamp: now,
            data,
          },
          ...prev.filter((a: ActivityEvent) => now - a.timestamp < 300_000),
        ].slice(0, MAX_ACTIVITY_EVENTS)
        return newEvents
      })
    }

    function noteMention(msg: Extract<ServerMessage, { type: "peer.mention" }>) {
      const now = Date.now()
      setMentions((prev) =>
        [{ from: msg.from, text: msg.text, messageID: msg.messageID, time: now }, ...prev].slice(0, 20),
      )
      logActivity("mention", msg.from.id, { ...msg.from }, { messageID: msg.messageID, text: msg.text })
      const href =
        msg.sessionID && msg.from.directory
          ? `/${base64Encode(msg.from.directory)}/session/${msg.sessionID}`
          : undefined
      const title = language.t("notification.mention.title", { name: msg.from.name })
      const description = language.t("notification.mention.description", { text: msg.text })
      showToast({
        title,
        description,
        actions: href
          ? [
              {
                label: language.t("notification.action.goToSession"),
                onClick: () => handleNotificationClick(href),
              },
              {
                label: language.t("common.dismiss"),
                onClick: "dismiss",
              },
            ]
          : undefined,
      })
      if (settings.sounds.agentEnabled()) {
        void playSoundById(settings.sounds.agent())
      }
      if (settings.notifications.agent() && href) {
        void platform.notify(title, description, href, { force: true })
      }
    }

    function resolveLocal(peer: PeerInfo, send: (msg: ClientMessage) => void) {
      const savedName = localStorage.getItem(PRESENCE_NAME_KEY)
      const savedColor = localStorage.getItem(PRESENCE_COLOR_KEY)
      const finalName = savedName || peer.name
      const finalColor = savedColor || peer.color
      if (!savedName) localStorage.setItem(PRESENCE_NAME_KEY, peer.name)
      if (!savedColor) localStorage.setItem(PRESENCE_COLOR_KEY, peer.color)
      const nameDiffers = savedName && savedName !== peer.name
      const colorDiffers = savedColor && savedColor !== peer.color
      if (nameDiffers || colorDiffers) {
        send({ type: "name", name: finalName, color: finalColor })
      }
      return { ...peer, name: finalName, color: finalColor }
    }

    // ── WebSocket URL ──

    function wsUrl(sessionID: string, scope: "session" | "directory" | "global" = "session"): string {
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
      base.searchParams.set("scope", scope)
      const savedName = localStorage.getItem(PRESENCE_NAME_KEY)
      if (savedName) {
        base.searchParams.set("name", savedName)
      }
      const savedColor = localStorage.getItem(PRESENCE_COLOR_KEY)
      if (savedColor) {
        base.searchParams.set("color", savedColor)
      }
      base.searchParams.set("browser", detectBrowser())
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
        url = wsUrl(sessionID, "session")
        console.log("[presence] connecting to", url)
        ws = new WebSocket(url)
      } catch (e) {
        console.error("[presence] failed to create WebSocket", e)
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        console.log("[presence] ws.onopen fired, setting connected=true")
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

    function connectDirectory() {
      const dir = decode64(params.dir)
      if (!dir || !server.current) return

      let url: string
      try {
        url = wsUrl(`__directory__:${dir}`, "directory")
        directoryWs = new WebSocket(url)
      } catch {
        scheduleDirectoryReconnect()
        return
      }

      directoryWs.onopen = () => {
        setDirectoryConnected(true)
        directoryReconnectDelay = RECONNECT_DELAY_MS
        directoryPingTimer = setInterval(() => {
          sendDirectoryMessage({ type: "ping" })
        }, PING_INTERVAL_MS)
      }

      directoryWs.onmessage = (event) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        handleDirectoryMessage(msg)
      }

      directoryWs.onclose = () => {
        cleanupDirectory()
        scheduleDirectoryReconnect()
      }

      directoryWs.onerror = () => {
        cleanupDirectory()
        scheduleDirectoryReconnect()
      }
    }

    function connectGlobal() {
      if (!server.current) return

      let url: string
      try {
        url = wsUrl("__global__", "global")
        globalWs = new WebSocket(url)
      } catch {
        scheduleGlobalReconnect()
        return
      }

      globalWs.onopen = () => {
        setGlobalConnected(true)
        globalReconnectDelay = RECONNECT_DELAY_MS
        globalPingTimer = setInterval(() => {
          sendGlobalMessage({ type: "ping" })
        }, PING_INTERVAL_MS)
      }

      globalWs.onmessage = (event) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        handleGlobalMessage(msg)
      }

      globalWs.onclose = () => {
        cleanupGlobal()
        scheduleGlobalReconnect()
      }

      globalWs.onerror = () => {
        cleanupGlobal()
        scheduleGlobalReconnect()
      }
    }

    function cleanup() {
      console.log("[presence] cleanup called, setting connected=false")
      setConnected(false)
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = undefined
      ws = null
    }

    function cleanupDirectory() {
      setDirectoryConnected(false)
      if (directoryPingTimer) clearInterval(directoryPingTimer)
      directoryPingTimer = undefined
      directoryWs = null
    }

    function cleanupGlobal() {
      setGlobalConnected(false)
      if (globalPingTimer) clearInterval(globalPingTimer)
      globalPingTimer = undefined
      globalWs = null
    }

    function disconnect() {
      console.log("[presence] disconnect called, ws exists:", !!ws, "ws readyState:", ws?.readyState)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = undefined
      if (inputTimer) clearTimeout(inputTimer)
      inputTimer = undefined
      if (mouseTimer) clearTimeout(mouseTimer)
      mouseTimer = undefined
      if (ws) {
        console.log("[presence] clearing ws handlers and closing")
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      cleanup()
      setSessionLocal(null)
      setRecentStops([])
      setStore("peers", reconcile({}))
      console.log("[presence] disconnect done, peers cleared")
    }

    function disconnectDirectory() {
      if (directoryReconnectTimer) clearTimeout(directoryReconnectTimer)
      directoryReconnectTimer = undefined
      if (directoryWs) {
        directoryWs.onclose = null
        directoryWs.onmessage = null
        directoryWs.onerror = null
        directoryWs.close()
      }
      cleanupDirectory()
      setDirectoryLocal(null)
      setDirectoryStore("peers", reconcile({}))
    }

    function disconnectGlobal() {
      if (globalReconnectTimer) clearTimeout(globalReconnectTimer)
      globalReconnectTimer = undefined
      if (globalWs) {
        globalWs.onclose = null
        globalWs.onmessage = null
        globalWs.onerror = null
        globalWs.close()
      }
      cleanupGlobal()
      setGlobalLocal(null)
      setGlobalStore("peers", reconcile({}))
    }

    function scheduleReconnect() {
      if (reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS)
        connect()
      }, reconnectDelay)
    }

    function scheduleDirectoryReconnect() {
      if (directoryReconnectTimer) return
      directoryReconnectTimer = setTimeout(() => {
        directoryReconnectTimer = undefined
        directoryReconnectDelay = Math.min(directoryReconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS)
        connectDirectory()
      }, directoryReconnectDelay)
    }

    function scheduleGlobalReconnect() {
      if (globalReconnectTimer) return
      globalReconnectTimer = setTimeout(() => {
        globalReconnectTimer = undefined
        globalReconnectDelay = Math.min(globalReconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS)
        connectGlobal()
      }, globalReconnectDelay)
    }

    // ── Message Handling ──

    function handleMessage(msg: ServerMessage) {
      const currentSessionID = params.id
      console.log("[presence] handleMessage", { type: msg.type, currentSessionID })

      switch (msg.type) {
        case "welcome": {
          const peer = resolveLocal(msg.peer, sendMessage)

          console.log("[presence] welcome received", {
            sessionID: currentSessionID,
            myPeerID: msg.peer.id,
            peersCount: msg.peers.length,
            peerNames: msg.peers.map((p) => p.name),
          })

          setSessionLocal(peer)
          batch(() => {
            const peers: Record<string, PeerState> = {}
            for (const p of msg.peers) {
              if (p.id !== msg.peer.id) {
                peers[p.id] = { ...p, input: undefined }
              }
            }
            console.log("[presence] setting peers", { count: Object.keys(peers).length, keys: Object.keys(peers) })
            setStore("peers", reconcile(peers))
            for (const p of msg.peers) {
              if (p.id !== msg.peer.id) {
                logActivity("join", p.id, { ...p, input: undefined })
              }
            }
          })
          break
        }
        case "peer.joined": {
          setStore("peers", msg.peer.id, { ...msg.peer, input: undefined })
          const peer = store.peers[msg.peer.id]
          if (peer) logActivity("join", msg.peer.id, peer)
          break
        }
        case "peer.left": {
          const leftPeer = store.peers[msg.peerID]
          if (leftPeer) logActivity("leave", msg.peerID, leftPeer)
          setStore(
            produce((s) => {
              delete s.peers[msg.peerID]
            }),
          )
          break
        }
        case "peer.cursor": {
          setStore("peers", msg.peerID, "cursor", msg.cursor)
          const cursorPeer = store.peers[msg.peerID]
          if (cursorPeer) logActivity("cursor", msg.peerID, cursorPeer, { area: msg.cursor.area })
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
            const snap = store.peers[msg.peerID]
            if (snap) {
              const now = Date.now()
              setRecentStops((prev) => [{ peer: { ...snap }, time: now }, ...prev.filter((s) => now - s.time < 30_000)])
              logActivity("typing", msg.peerID, snap)
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
          setStore("peers", msg.peerID, (peer) => ({
            ...peer,
            ...(msg.name !== undefined && { name: msg.name }),
            ...(msg.color !== undefined && { color: msg.color }),
          }))
          break
        }
        case "peer.mention": {
          noteMention(msg)
          break
        }
        case "pong": {
          break
        }
      }
    }

    function handleDirectoryMessage(msg: ServerMessage) {
      switch (msg.type) {
        case "welcome": {
          const peer = resolveLocal(msg.peer, sendDirectoryMessage)
          setDirectoryLocal(peer)
          const peers: Record<string, PeerState> = {}
          for (const p of msg.peers) {
            if (p.id !== msg.peer.id) {
              peers[p.id] = { ...p, input: undefined }
            }
          }
          setDirectoryStore("peers", reconcile(peers))
          break
        }
        case "peer.joined": {
          setDirectoryStore("peers", msg.peer.id, { ...msg.peer, input: undefined })
          break
        }
        case "peer.left": {
          setDirectoryStore(
            produce((s) => {
              delete s.peers[msg.peerID]
            }),
          )
          break
        }
        case "peer.name": {
          setDirectoryStore("peers", msg.peerID, (peer) => ({
            ...peer,
            ...(msg.name !== undefined && { name: msg.name }),
            ...(msg.color !== undefined && { color: msg.color }),
          }))
          break
        }
        case "peer.mention": {
          noteMention(msg)
          break
        }
        case "pong": {
          break
        }
      }
    }

    function handleGlobalMessage(msg: ServerMessage) {
      switch (msg.type) {
        case "welcome": {
          const peer = resolveLocal(msg.peer, sendGlobalMessage)
          setGlobalLocal(peer)
          const peers: Record<string, PeerState> = {}
          for (const p of msg.peers) {
            if (p.id !== msg.peer.id) peers[p.id] = { ...p, input: undefined }
          }
          setGlobalStore("peers", reconcile(peers))
          break
        }
        case "peer.joined": {
          setGlobalStore("peers", msg.peer.id, { ...msg.peer, input: undefined })
          break
        }
        case "peer.left": {
          setGlobalStore(
            produce((s) => {
              delete s.peers[msg.peerID]
            }),
          )
          break
        }
        case "peer.name": {
          setGlobalStore("peers", msg.peerID, (peer) => ({
            ...peer,
            ...(msg.name !== undefined && { name: msg.name }),
            ...(msg.color !== undefined && { color: msg.color }),
          }))
          break
        }
        case "peer.mention": {
          noteMention(msg)
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

    function sendDirectoryMessage(msg: ClientMessage) {
      if (!directoryWs || directoryWs.readyState !== WebSocket.OPEN) return
      try {
        directoryWs.send(JSON.stringify(msg))
      } catch {
        // connection closing
      }
    }

    function sendGlobalMessage(msg: ClientMessage) {
      if (!globalWs || globalWs.readyState !== WebSocket.OPEN) return
      try {
        globalWs.send(JSON.stringify(msg))
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

    function sendMention(peerID: string, text: string, messageID?: string) {
      if (!peerID || !text.trim()) return
      const msg: ClientMessage = { type: "mention", peerID, text, messageID, sessionID: params.id }
      if (globalWs?.readyState === WebSocket.OPEN) {
        sendGlobalMessage(msg)
        return
      }
      if (directoryWs?.readyState === WebSocket.OPEN) {
        sendDirectoryMessage(msg)
        return
      }
      sendMessage(msg)
    }

    function setName(name: string, color?: string) {
      const trimmed = name.trim()
      if (!trimmed) return
      localStorage.setItem(PRESENCE_NAME_KEY, trimmed)
      if (color) localStorage.setItem(PRESENCE_COLOR_KEY, color)
      sendMessage({ type: "name", name: trimmed, color })
      sendDirectoryMessage({ type: "name", name: trimmed, color })
      sendGlobalMessage({ type: "name", name: trimmed, color })
      setSessionLocal((prev) => (prev ? { ...prev, name: trimmed, ...(color && { color }) } : null))
      setDirectoryLocal((prev) => (prev ? { ...prev, name: trimmed, ...(color && { color }) } : null))
      setGlobalLocal((prev) => (prev ? { ...prev, name: trimmed, ...(color && { color }) } : null))
    }

    function setColor(color: string) {
      if (!color) return
      localStorage.setItem(PRESENCE_COLOR_KEY, color)
      const currentName = localPeer()?.name
      if (currentName) {
        sendMessage({ type: "name", name: currentName, color })
        sendDirectoryMessage({ type: "name", name: currentName, color })
        sendGlobalMessage({ type: "name", name: currentName, color })
      }
      setSessionLocal((prev) => (prev ? { ...prev, color } : null))
      setDirectoryLocal((prev) => (prev ? { ...prev, color } : null))
      setGlobalLocal((prev) => (prev ? { ...prev, color } : null))
    }

    const hasName = () => !!localStorage.getItem(PRESENCE_NAME_KEY)

    // ── Mouse tracking ──

    const MOUSE_THROTTLE_MS = 50

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

    createEffect(() => {
      console.log("[presence] params.id changed:", params.id)
    })

    const sessionID = createMemo(() => {
      const id = params.id
      console.log("[presence] sessionID memo evaluated:", id)
      return id
    })

    console.log("[presence] init, params.id =", params.id, "server.current =", !!server.current)

    createEffect(
      on(sessionID, (id, prev) => {
        console.log("[presence] sessionID effect fired:", { id, prev, timestamp: Date.now() })
        if (prev) {
          console.log("[presence] cleaning up previous session:", prev)
          setStore("peers", reconcile({}))
          setSessionLocal(null)
          console.log("[presence] cleared peers and localPeer, calling disconnect")
          disconnect()
          console.log("[presence] disconnect completed")
        }
        if (id) {
          console.log("[presence] connecting to session:", id)
          connect()
        }
      }),
    )

    createEffect(
      on(
        () => decode64(params.dir),
        (dir, prev) => {
          if (prev) disconnectDirectory()
          if (dir) connectDirectory()
        },
      ),
    )

    createEffect(() => {
      if (!server.current) return
      connectGlobal()
    })

    onCleanup(() => {
      disconnect()
      disconnectDirectory()
      disconnectGlobal()
    })

    // ── Public API ──

    const peers = createMemo(() => {
      const result = Object.values(store.peers)
      console.log("[presence] peers memo evaluated:", { count: result.length, names: result.map((p) => p.name) })
      return result
    })
    const directoryPeers = createMemo(() => Object.values(directoryStore.peers))
    const globalPeers = createMemo(() => Object.values(globalStore.peers))
    const mentionPeers = createMemo(() => {
      const global = globalPeers()
      if (globalConnected() || global.length > 0) return global
      const result = directoryPeers()
      if (directoryConnected() || result.length > 0) return result
      return peers()
    })
    const peerCount = createMemo(() => Object.keys(store.peers).length)
    const localPeer = createMemo(() => sessionLocal() ?? directoryLocal() ?? globalLocal())

    const mentionMeta = (peer: PeerInfo) => {
      const local = decode64(params.dir)
      const sameWorkspace = !!peer.directory && !!local && peer.directory === local
      const workspace = peer.directory ? getFilename(peer.directory) : undefined
      return {
        workspace,
        sameWorkspace,
        sessionID: peer.session_id,
      }
    }

    const localPeerFallback = () => {
      const p = localPeer()
      if (p) return p
      const name = localStorage.getItem(PRESENCE_NAME_KEY)
      const color = localStorage.getItem(PRESENCE_COLOR_KEY)
      if (name && color) {
        return { id: "local", name, color, connectedAt: 0, isTyping: false }
      }
      return null
    }

    return {
      localPeer,
      localPeerFallback,
      peers,
      directoryPeers,
      globalPeers,
      mentionPeers,
      mentionMeta,
      peerCount,
      connected,
      directoryConnected,
      globalConnected,
      recentStops,
      activities,
      mentions,
      peer: (id: string) => store.peers[id] as PeerState | undefined,
      sendCursor,
      sendInput,
      sendTyping,
      sendMention,
      sendMouse,
      setName,
      setColor,
      hasName,
    }
  },
})
