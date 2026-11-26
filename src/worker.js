// Fleet Command – Cloudflare Worker (Multiplayer + Verifiziert-Haken + Admin)
// Routen:
//   WebSocket auf /room/main (oder jedem anderen Pfad)  -> Multiplayer-Raum
//   GET  /api/verified?u=<host>                          -> {"v":true|false}
//   POST /api/admin  {pw, action, host|newpw}            -> Admin-Menü
//   GET  /                                               -> Lebenszeichen

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // WebSocket: jeder Pfad geht, /room/<name> wählt den Raum, sonst "main"
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const m = /^\/room\/([\w-]{1,40})/.exec(url.pathname);
      const name = m ? m[1] : 'main';
      return env.HUB.get(env.HUB.idFromName('room:' + name)).fetch(req);
    }

    if (url.pathname.startsWith('/api/')) {
      return env.HUB.get(env.HUB.idFromName('admin')).fetch(req);
    }

    return new Response('Fleet Command Server läuft ✓', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return this.api(req, url);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- Multiplayer: Nachrichten an alle anderen im Raum weiterreichen ----------
  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 30000) return;
    for (const other of this.state.getWebSockets()) {
      if (other !== ws) {
        try { other.send(msg); } catch (e) {}
      }
    }
  }
  webSocketClose(ws) { try { ws.close(1000, ''); } catch (e) {} }
  webSocketError(ws) { try { ws.close(1000, ''); } catch (e) {} }

  // ---------- Verifiziert + Admin ----------
  async hash(pw, salt) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + pw));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async pwOk(pw) {
    const st = this.state.storage;
    const rec = await st.get('pw');
    if (rec) return (await this.hash(pw, rec.s)) === rec.h;
    const init = this.env.ADMIN_PW || 'FelixundTimonsindcool';
    return pw === init;
  }

  async api(req, url) {
    const st = this.state.storage;

    if (url.pathname === '/api/verified') {
      const h = (url.searchParams.get('u') || '').toLowerCase().replace(/[^\w.:-]/g, '');
      const list = (await st.get('list')) || [];
      return json({ v: !!h && list.includes(h) });
    }

    if (url.pathname === '/api/admin' && req.method === 'POST') {
      let b;
      try { b = await req.json(); } catch (e) { return json({ error: 'Ungültige Anfrage' }, 400); }

      // Schutz gegen Passwort-Raten: max. 5 Fehlversuche pro Minute
      const now = Date.now();
      let f = (await st.get('fail')) || { n: 0, t: now };
      if (now - f.t > 60000) f = { n: 0, t: now };
      if (f.n >= 5) return json({ error: 'Zu viele Versuche, bitte 1 Minute warten' }, 429);

      if (!(await this.pwOk(String(b.pw || '')))) {
        f.n++;
        await st.put('fail', f);
        return json({ error: 'Falsches Passwort' }, 401);
      }
      if (f.n) await st.put('fail', { n: 0, t: now });

      let list = (await st.get('list')) || [];
      const clean = s => String(s || '').trim().replace(/^\w+:\/\//, '').split('/')[0].toLowerCase().replace(/[^\w.:-]/g, '');

      switch (b.action) {
        case 'list':
          return json({ ok: true, list });
        case 'add': {
          const h = clean(b.host);
          if (!h) return json({ error: 'Keine gültige Adresse' }, 400);
          if (list.length >= 200) return json({ error: 'Liste ist voll' }, 400);
          if (!list.includes(h)) list.push(h);
          await st.put('list', list);
          return json({ ok: true, list });
        }
        case 'remove': {
          const h = clean(b.host);
          list = list.filter(x => x !== h);
          await st.put('list', list);
          return json({ ok: true, list });
        }
        case 'passwd': {
          const n = String(b.newpw || '');
          if (n.length < 8) return json({ error: 'Mindestens 8 Zeichen' }, 400);
          const s = crypto.randomUUID();
          await st.put('pw', { s, h: await this.hash(n, s) });
          return json({ ok: true });
        }
        default:
          return json({ error: 'Unbekannte Aktion' }, 400);
      }
    }

    return json({ error: 'Nicht gefunden' }, 404);
  }
}
