import { NextRequest, NextResponse } from "next/server"
import { redis } from "./lib/redis"

export const proxy = async (req: NextRequest) => {
    const pathname = req.nextUrl.pathname

    const roomMatch = pathname.match(/^\/room\/([^/]+)$/)
    if(!roomMatch) return NextResponse.redirect(new URL("/", req.url))

    const roomId = roomMatch[1]
    const exists = await redis.exists(`meta:${roomId}`)
    if (!exists) {
        return NextResponse.redirect(new URL("/?error=room-not-found", req.url))
    }
    return NextResponse.next()
}

export const config = {
    matcher: "/room/:path*",
}
