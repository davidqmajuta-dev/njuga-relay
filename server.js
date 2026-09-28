// NJUGA/CASINO online-rooms relay server.
//
// This server does NOT know the rules of the card game. It only does two things:
//   1. Lets one phone create a room and get back a short room code.
//   2. Lets a second phone join that room with the code, then relays every
//      message either phone sends straight to the other phone.
//
// The game logic keeps running exactly as it already does on the "host"
// phone (the same functions that currently run the AI's turn), just fed by
// the guest's moves instead of the AI. This file is intentionally dumb on
// purpose — the game stays private between the two phones; the server never
// sees card values, only opaque JSON messages it forwards.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;

// code -> { host: ws|null, guest: ws|null, createdAt: number }
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function otherSide(room, ws) {
  return room.host === ws ? room.guest : room.host;
}

function cleanupEmptyRoom(code) {
  const room = rooms.get(code);
  if (room && !room.host && !room.guest) rooms.delete(code);
}

// Basic HTTP server: WebSocket upgrades ride on top of this. The plain GET
// handler exists so the hosting platform's health check has something to hit.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`njuga-casino relay ok — ${rooms.size} open room(s)\n`);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null; // 'host' | 'guest'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case 'create': {
        const code = makeRoomCode();
        rooms.set(code, { host: ws, guest: null, createdAt: Date.now() });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'created', code });
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'join-error', reason: 'no-such-room' }); return; }
        if (room.guest) { send(ws, { type: 'join-error', reason: 'room-full' }); return; }
        room.guest = ws;
        ws.roomCode = code;
        ws.role = 'guest';
        send(ws, { type: 'joined', code });
        send(room.host, { type: 'peer-joined' }); // tells the host to start the match
        break;
      }

      case 'relay': {
        // Anything game-specific — moves, full state snapshots, chat — flows
        // through here untouched. The server never inspects msg.payload.
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const peer = otherSide(room, ws);
        send(peer, { type: 'relay', payload: msg.payload });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (room.host === ws) room.host = null;
    if (room.guest === ws) room.guest = null;
    const peer = otherSide(room, ws);
    send(peer, { type: 'peer-left' });
    cleanupEmptyRoom(ws.roomCode);
  });
});

// Rooms nobody ever joined get swept out after 30 minutes so memory doesn't
// grow forever on a long-running free-tier instance.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (!room.guest && room.createdAt < cutoff) rooms.delete(code);
  }
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`njuga-casino relay listening on :${PORT}`);
});
