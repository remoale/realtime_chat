import { redis } from '@/lib/redis'
import { Elysia } from 'elysia'
import { nanoid } from 'nanoid'
import { authMiddleware } from './auth'
import { z } from "zod"
import { Message, realtime } from '@/lib/realtime'

const ROOM_TTL_SECONDS = 60 * 10

const rooms = new Elysia({ prefix: "/room" })
    .post("/create", async () => {
        const roomId = nanoid()

        await redis.hset(`meta:${roomId}`, {
            connected: [],
            createdAt: Date.now(),
        })

        await redis.expire(`meta:${roomId}`, ROOM_TTL_SECONDS)

        return { roomId }
    })
    .post("/join", async ({ query, cookie, set }) => {
        const { roomId } = query
        const meta = await redis.hgetall<{ connected: string[] }>(`meta:${roomId}`)

        if (!meta) {
            set.status = 404
            return { error: "Room not found" }
        }

        const connected = meta.connected ?? []
        const existingToken = cookie["x-auth-token"]?.value as string | undefined

        if (existingToken && connected.includes(existingToken)) {
            return { ok: true }
        }

        if (connected.length >= 2) {
            set.status = 409
            return { error: "Room full" }
        }

        const token = nanoid()
        await redis.hset(`meta:${roomId}`, {
            connected: [...connected, token],
        })

        cookie["x-auth-token"].set({
            value: token,
            path: "/",
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
        })

        return { ok: true }
    }, { query: z.object({ roomId: z.string() }) })
    .use(authMiddleware)
    .get("/ttl", async ({ auth }) => {
        const ttl = await redis.ttl(`meta:${auth.roomId}`)
        return { ttl: ttl > 0 ? ttl : 0 }
    }, { query: z.object({ roomId: z.string() })})
    .delete("/", async ({ auth }) => {
        await realtime.channel(auth.roomId).emit("chat.destroy", { isDestroyed: true })
        
        await Promise.all([
            redis.del(auth.roomId),
            redis.del(`meta:${auth.roomId}`),
            redis.del(`messages:${auth.roomId}`),
        ])
    }, { query: z.object({ roomId: z.string() }) } 
)

const messages = new Elysia({ prefix: "/messages" })
    .use(authMiddleware)
    .post("/", async ({ body, auth }) => {
        const { sender, text } = body
        const { roomId } = auth

        const roomExists = await redis.exists(`meta:${roomId}`)

        if (!roomExists) {
            throw new Error("Room does not exist")
        }

        const message: Message = {
            id: nanoid(),
            sender,
            text,
            timestamp: Date.now(),
            roomId,
        }

        await redis.rpush(`messages:${roomId}`, { ...message, token: auth.token })
        await realtime.channel(roomId).emit("chat.message", message)

        const remaining = await redis.ttl(`meta:${roomId}`)

        await Promise.all([
            redis.expire(`messages:${roomId}`, remaining),
            redis.expire(`history:${roomId}`, remaining),
            redis.expire(roomId, remaining),
        ])
    }, {
        query: z.object({ roomId: z.string() }),
        body: z.object({
            sender: z.string().max(100),
            text: z.string().max(1000),
        }),
    }
).get("/",
    async ({ auth }) => {
        const messages = await redis.lrange<Message>(`messages:${auth.roomId}`, 0, -1)

        return { 
            messages: messages.map((m) => ({
            ...m,
            token: m.token === auth.token ? auth.token : undefined,
            })),
        }
    }, { query: z.object({ roomId: z.string() }) }
)

const app = new Elysia({ prefix: "/api" }).use(rooms).use(messages)

export const GET = app.fetch
export const POST = app.fetch
export const DELETE = app.fetch

export type App = typeof app
