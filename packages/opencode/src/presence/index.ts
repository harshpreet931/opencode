import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "../util/log"

const log = Log.create({ service: "presence" })

export namespace Presence {
  // ── Schemas ──────────────────────────────────────────────

  export const CursorArea = z.enum(["prompt", "message-timeline", "terminal", "file-tree", "review", "idle"])
  export type CursorArea = z.infer<typeof CursorArea>

  export const CursorState = z.object({
    area: CursorArea,
    position: z.number().optional(),
    selection: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .optional(),
    scrollY: z.number().optional(),
    messageID: z.string().optional(),
  })
  export type CursorState = z.infer<typeof CursorState>

  export const PeerInfo = z
    .object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      connectedAt: z.number(),
      cursor: CursorState.optional(),
      isTyping: z.boolean(),
    })
    .meta({ ref: "PresencePeer" })
  export type PeerInfo = z.infer<typeof PeerInfo>

  export const InputSnapshot = z.object({
    text: z.string(),
    cursorPosition: z.number().optional(),
  })
  export type InputSnapshot = z.infer<typeof InputSnapshot>

  // ── Bus Events ──────────────────────────────────────────

  export const Event = {
    PeerJoined: BusEvent.define(
      "presence.peer.joined",
      z.object({
        sessionID: z.string(),
        peer: PeerInfo,
      }),
    ),
    PeerLeft: BusEvent.define(
      "presence.peer.left",
      z.object({
        sessionID: z.string(),
        peerID: z.string(),
      }),
    ),
    PeerUpdated: BusEvent.define(
      "presence.peer.updated",
      z.object({
        sessionID: z.string(),
        peerID: z.string(),
        cursor: CursorState.optional(),
        input: InputSnapshot.optional(),
        isTyping: z.boolean().optional(),
      }),
    ),
  }

  // ── Color Assignment ────────────────────────────────────

  const PEER_COLORS = [
    "#FF6B6B",
    "#4ECDC4",
    "#45B7D1",
    "#96CEB4",
    "#FFEAA7",
    "#DDA0DD",
    "#98D8C8",
    "#F7DC6F",
    "#BB8FCE",
    "#85C1E9",
  ] as const

  let colorIndex = 0
  function nextColor(): string {
    const color = PEER_COLORS[colorIndex % PEER_COLORS.length]
    colorIndex++
    return color
  }

  // ── Random Names ────────────────────────────────────────

  const ADJECTIVES = ["Swift", "Quiet", "Bold", "Bright", "Clever", "Gentle", "Keen", "Nimble", "Sharp", "Steady"]
  const ANIMALS = ["Falcon", "Panda", "Fox", "Otter", "Hawk", "Lynx", "Owl", "Wolf", "Heron", "Seal"]

  function randomName(): string {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
    return `${adj} ${animal}`
  }

  // ── Socket Type ─────────────────────────────────────────

  type Socket = {
    readyState: number
    send: (data: string | Uint8Array | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  // ── Session Presence State ──────────────────────────────

  type PeerConnection = {
    info: PeerInfo
    socket: Socket
    lastActivity: number
    input?: InputSnapshot
  }

  type SessionPresence = {
    peers: Map<string, PeerConnection>
  }

  const sessions = new Map<string, SessionPresence>()

  function getSession(sessionID: string): SessionPresence {
    let session = sessions.get(sessionID)
    if (!session) {
      session = { peers: new Map() }
      sessions.set(sessionID, session)
    }
    return session
  }

  function cleanupSession(sessionID: string) {
    const session = sessions.get(sessionID)
    if (session && session.peers.size === 0) {
      sessions.delete(sessionID)
    }
  }

  // ── Public API ──────────────────────────────────────────

  export function join(sessionID: string, socket: Socket, opts?: { name?: string; color?: string }): PeerConnection {
    const session = getSession(sessionID)
    const id = crypto.randomUUID()
    const peer: PeerInfo = {
      id,
      name: opts?.name || randomName(),
      color: opts?.color || nextColor(),
      connectedAt: Date.now(),
      isTyping: false,
    }
    const conn: PeerConnection = {
      info: peer,
      socket,
      lastActivity: Date.now(),
    }
    session.peers.set(id, conn)
    log.info("peer joined", { sessionID, peerID: id, name: peer.name })
    return conn
  }

  export function leave(sessionID: string, peerID: string) {
    const session = sessions.get(sessionID)
    if (!session) return
    const peer = session.peers.get(peerID)
    if (peer) {
      session.peers.delete(peerID)
      log.info("peer left", { sessionID, peerID, name: peer.info.name })
    }
    cleanupSession(sessionID)
  }

  export function getPeers(sessionID: string): PeerInfo[] {
    const session = sessions.get(sessionID)
    if (!session) return []
    return Array.from(session.peers.values()).map((c) => c.info)
  }

  export function getPeerInput(sessionID: string, peerID: string): InputSnapshot | undefined {
    const session = sessions.get(sessionID)
    if (!session) return
    return session.peers.get(peerID)?.input
  }

  /** Broadcast a message to all peers in a session EXCEPT the sender */
  export function broadcast(sessionID: string, senderID: string, message: string) {
    const session = sessions.get(sessionID)
    if (!session) return
    for (const [id, conn] of session.peers) {
      if (id === senderID) continue
      if (conn.socket.readyState !== 1) {
        session.peers.delete(id)
        continue
      }
      try {
        conn.socket.send(message)
      } catch {
        session.peers.delete(id)
      }
    }
    cleanupSession(sessionID)
  }

  /** Update a peer's state */
  export function updatePeer(
    sessionID: string,
    peerID: string,
    update: {
      cursor?: CursorState
      input?: InputSnapshot
      isTyping?: boolean
      name?: string
      color?: string
    },
  ) {
    const session = sessions.get(sessionID)
    if (!session) return
    const conn = session.peers.get(peerID)
    if (!conn) return

    conn.lastActivity = Date.now()

    if (update.cursor) {
      conn.info.cursor = update.cursor
    }
    if (update.input !== undefined) {
      conn.input = update.input
    }
    if (update.isTyping !== undefined) {
      conn.info.isTyping = update.isTyping
    }
    if (update.name) {
      conn.info.name = update.name
    }
    if (update.color) {
      conn.info.color = update.color
    }
  }

  // ── Stale Cleanup ───────────────────────────────────────

  const STALE_TIMEOUT_MS = 30_000

  export function cleanupStale() {
    const now = Date.now()
    for (const [sessionID, session] of sessions) {
      for (const [peerID, conn] of session.peers) {
        if (now - conn.lastActivity > STALE_TIMEOUT_MS) {
          log.info("removing stale peer", { sessionID, peerID })
          try {
            conn.socket.close(1000, "stale")
          } catch {}
          session.peers.delete(peerID)
        }
      }
      cleanupSession(sessionID)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void setInterval(cleanupStale, 15_000)
}
