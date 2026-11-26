import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 40;
const MAX_MSG = 32 * 1024;

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket erwartet", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("Raum voll", { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try { other.send(message); } catch (e) {}
      }
    }
  }

  webSocketClose(ws) {
    try { ws.close(1000); } catch (e) {}
  }

  webSocketError(ws) {
    try { ws.close(1000); } catch (e) {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})$/);
    if (!m) return new Response("Fleet Command Server läuft.", { status: 200 });
    const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
    return stub.fetch(request);
  },
};
