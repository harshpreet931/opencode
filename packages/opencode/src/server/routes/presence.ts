import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import type { UpgradeWebSocket } from "hono/ws"
import z from "zod"
import { Presence } from "@/presence"
import { Bus } from "@/bus"
import { Log } from "@/util/log"

const log = Log.create({ service: "presence" })

// ── Wire Protocol ───────────────────────────────────────

const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cursor"),
    area: Presence.CursorArea,
    position: z.number().optional(),
    selection: z.object({ start: z.number(), end: z.number() }).optional(),
    scrollY: z.number().optional(),
    messageID: z.string().optional(),
  }),
  z.object({
    type: z.literal("input"),
    text: z.string(),
    cursorPosition: z.number().optional(),
  }),
  z.object({
    type: z.literal("typing"),
    isTyping: z.boolean(),
  }),
  z.object({
    type: z.literal("mouse"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("name"),
    name: z.string().min(1).max(30),
    color: z.string().optional(),
  }),
  z.object({
    type: z.literal("mention"),
    peerID: z.string(),
    text: z.string().min(1),
    messageID: z.string().optional(),
    sessionID: z.string().optional(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
])

type ServerMessage =
  | { type: "welcome"; peer: Presence.PeerInfo; peers: Presence.PeerInfo[] }
  | { type: "peer.joined"; peer: Presence.PeerInfo }
  | { type: "peer.left"; peerID: string }
  | { type: "peer.cursor"; peerID: string; cursor: Presence.CursorState }
  | { type: "peer.input"; peerID: string; text: string; cursorPosition?: number }
  | { type: "peer.typing"; peerID: string; isTyping: boolean }
  | { type: "peer.mouse"; peerID: string; x: number; y: number }
  | { type: "peer.name"; peerID: string; name: string; color?: string }
  | {
      type: "peer.mention"
      peerID: string
      from: Presence.PeerInfo
      text: string
      messageID?: string
      sessionID?: string
    }
  | { type: "pong" }

function sendJSON(
  socket: { send: (data: string | Uint8Array | ArrayBuffer) => void; readyState: number },
  msg: ServerMessage,
) {
  if (socket.readyState !== 1) return
  try {
    socket.send(JSON.stringify(msg))
  } catch {
    // connection closing
  }
}

export function PresenceRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono().get(
    "/:sessionID",
    describeRoute({
      summary: "Connect to session presence",
      description:
        "Establish a WebSocket connection for real-time collaborative presence in a session. " +
        "Provides cursor positions, typing indicators, and live input previews of all connected peers.",
      operationId: "presence.connect",
      responses: {
        200: {
          description: "WebSocket connection established",
        },
      },
    }),
    validator(
      "param",
      z.object({
        sessionID: z.string(),
      }),
    ),
    upgradeWebSocket(async (c) => {
      const sessionID = c.req.param("sessionID")
      const name = c.req.query("name") || undefined
      const color = c.req.query("color") || undefined
      const browser = c.req.query("browser") || undefined
      const directory = c.req.query("directory") || undefined
      const scope = c.req.query("scope")
      const kind = scope === "directory" || scope === "global" || scope === "session" ? scope : undefined

      type Socket = {
        readyState: number
        send: (data: string | Uint8Array | ArrayBuffer) => void
        close: (code?: number, reason?: string) => void
      }

      const isSocket = (value: unknown): value is Socket => {
        if (!value || typeof value !== "object") return false
        if (!("readyState" in value)) return false
        if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
        if (!("close" in value) || typeof (value as { close?: unknown }).close !== "function") return false
        return typeof (value as { readyState?: unknown }).readyState === "number"
      }

      let conn: ReturnType<typeof Presence.join> | undefined
      let peerID: string | undefined

      return {
        async onOpen(_event, ws) {
          const socket = ws.raw
          if (!isSocket(socket)) {
            ws.close()
            return
          }

          conn = Presence.join(sessionID, socket, { name, color, browser, scope: kind, directory })
          peerID = conn.info.id

          // Send welcome with current peer list
          const peers = Presence.getPeers(sessionID)
          sendJSON(socket, {
            type: "welcome",
            peer: conn.info,
            peers: peers.filter((p) => p.id !== peerID),
          })

          // Broadcast join to other peers
          Presence.broadcast(
            sessionID,
            peerID,
            JSON.stringify({
              type: "peer.joined",
              peer: conn.info,
            } satisfies ServerMessage),
          )

          // Publish to Bus for SSE subscribers
          await Bus.publish(Presence.Event.PeerJoined, {
            sessionID,
            peer: conn.info,
          })

          log.info("presence connected", {
            sessionID,
            peerID,
            name: conn.info.name,
            totalPeers: peers.length,
          })
        },

        onMessage(event) {
          if (!peerID || !conn) return
          if (typeof event.data !== "string") return

          let msg: z.infer<typeof ClientMessage>
          try {
            msg = ClientMessage.parse(JSON.parse(event.data))
          } catch {
            return
          }

          conn.lastActivity = Date.now()

          switch (msg.type) {
            case "cursor": {
              const cursor: Presence.CursorState = {
                area: msg.area,
                position: msg.position,
                selection: msg.selection,
                scrollY: msg.scrollY,
                messageID: msg.messageID,
              }
              Presence.updatePeer(sessionID, peerID, { cursor })
              Presence.broadcast(
                sessionID,
                peerID,
                JSON.stringify({
                  type: "peer.cursor",
                  peerID,
                  cursor,
                } satisfies ServerMessage),
              )
              break
            }

            case "input": {
              const input: Presence.InputSnapshot = {
                text: msg.text,
                cursorPosition: msg.cursorPosition,
              }
              Presence.updatePeer(sessionID, peerID, { input })
              Presence.broadcast(
                sessionID,
                peerID,
                JSON.stringify({
                  type: "peer.input",
                  peerID,
                  text: msg.text,
                  cursorPosition: msg.cursorPosition,
                } satisfies ServerMessage),
              )
              break
            }

            case "typing": {
              Presence.updatePeer(sessionID, peerID, { isTyping: msg.isTyping })
              Presence.broadcast(
                sessionID,
                peerID,
                JSON.stringify({
                  type: "peer.typing",
                  peerID,
                  isTyping: msg.isTyping,
                } satisfies ServerMessage),
              )
              break
            }

            case "name": {
              const update: { name: string; color?: string } = { name: msg.name }
              if (msg.color) update.color = msg.color
              Presence.updatePeer(sessionID, peerID, update)
              Presence.broadcast(
                sessionID,
                peerID,
                JSON.stringify({
                  type: "peer.name",
                  peerID,
                  name: msg.name,
                  color: msg.color,
                } satisfies ServerMessage),
              )
              break
            }

            case "mention": {
              const from = Presence.getPeer(sessionID, peerID)
              const to = Presence.getPeer(sessionID, msg.peerID)
              if (!from || !to) break
              Presence.send(
                sessionID,
                msg.peerID,
                JSON.stringify({
                  type: "peer.mention",
                  peerID: msg.peerID,
                  from,
                  text: msg.text,
                  messageID: msg.messageID,
                  sessionID: msg.sessionID,
                } satisfies ServerMessage),
              )
              void Bus.publish(Presence.Event.PeerMentioned, {
                sessionID,
                from,
                to,
                text: msg.text,
                messageID: msg.messageID,
              })
              break
            }

            case "mouse": {
              Presence.broadcast(
                sessionID,
                peerID,
                JSON.stringify({
                  type: "peer.mouse",
                  peerID,
                  x: msg.x,
                  y: msg.y,
                } satisfies ServerMessage),
              )
              break
            }

            case "ping": {
              if (conn.socket.readyState === 1) {
                sendJSON(conn.socket, { type: "pong" })
              }
              break
            }
          }
        },

        async onClose() {
          if (!peerID) return
          log.info("presence disconnected", { sessionID, peerID })

          Presence.leave(sessionID, peerID)

          Presence.broadcast(
            sessionID,
            peerID,
            JSON.stringify({
              type: "peer.left",
              peerID,
            } satisfies ServerMessage),
          )

          await Bus.publish(Presence.Event.PeerLeft, {
            sessionID,
            peerID,
          })
        },

        async onError() {
          if (!peerID) return
          Presence.leave(sessionID, peerID)
          Presence.broadcast(
            sessionID,
            peerID,
            JSON.stringify({
              type: "peer.left",
              peerID,
            } satisfies ServerMessage),
          )
        },
      }
    }),
  )
}
