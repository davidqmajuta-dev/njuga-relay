// NJUGA/CASINO relay server.
//
// This server does NOT know the rules of the card game. It only connects
// players into a room and passes messages between them — it never looks at
// card values.
//
// It runs two room shapes, chosen by maxPlayers on 'create':
//
//   1. Classic Online Rooms (maxPlayers omitted, or 2) — exactly the original
//      2-player protocol (create/join/relay/peer-joined/peer-left). Unchanged
//      on purpose, so the existing 1v1 client (www/online.js) needs no
//      changes and keeps working exactly as it always has.
//
//   2. Tournament rooms (maxPlayers 3-8) — up to 8 named seats. Seat 0 is
//      always the host, who runs the authoritative game (same pattern as the
//      2-player mode, just with more seats). Guests can only talk to the
//      host ('relay'); the host talks to one seat ('relay-to') or everyone
//      ('relay-all'), because each player's game view has to hide every
//      other seat's hand, so the host sends a different snapshot per seat
//      rather than one broadcast.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;

// code -> {
//   code, maxPlayers, buyIn,
//   seats: [ws|null, ...] length maxPlayers, seat 0 = host,
//   names: [string|null, ...] same length,
//   createdAt
// }
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
function safeName(n, fallback) {
  return String(n || fallback).slice(0, 20);
}
function clampMaxPlayers(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) return 2;
  return Math.max(2, Math.min(8, n));
}
function roomIsEmpty(room) {
  return room.seats.every((s) => !s);
}
function cleanupIfEmpty(code) {
  const room = rooms.get(code);
  if (room && roomIsEmpty(room)) rooms.delete(code);
}
function broadcastRoster(room) {
  const msg = { type: 'roster', names: room.names, maxPlayers: room.maxPlayers };
  room.seats.forEach((s) => send(s, msg));
}
function broadcastAll(room, msg, exceptSeat) {
  room.seats.forEach((s, i) => { if (s && i !== exceptSeat) send(s, msg); });
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
  ws.seat = null; // 0 = host, 1+ = guest seat, for BOTH room shapes

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case 'create': {
        const maxPlayers = clampMaxPlayers(msg.maxPlayers);
        const buyIn = Math.max(0, Number(msg.buyIn) || 0);
        const code = makeRoomCode();
        const seats = new Array(maxPlayers).fill(null);
        const names = new Array(maxPlayers).fill(null);
        seats[0] = ws;
        names[0] = safeName(msg.name, 'Host');
        rooms.set(code, { code, maxPlayers, buyIn, seats, names, createdAt: Date.now() });
        ws.roomCode = code;
        ws.seat = 0;

        if (maxPlayers === 2) {
          send(ws, { type: 'created', code }); // unchanged classic protocol
        } else {
          send(ws, { type: 'created', code, seat: 0, maxPlayers, buyIn });
          broadcastRoster(rooms.get(code));
        }
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'join-error', reason: 'no-such-room' }); return; }

        if (room.maxPlayers === 2) {
          if (room.seats[1]) { send(ws, { type: 'join-error', reason: 'room-full' }); return; }
          room.seats[1] = ws;
          ws.roomCode = code;
          ws.seat = 1;
          send(ws, { type: 'joined', code }); // unchanged classic protocol
          send(room.seats[0], { type: 'peer-joined' });
          break;
        }

        // Tournament room: claim the first open seat after the host.
        const seatIdx = room.seats.findIndex((s, i) => i > 0 && !s);
        if (seatIdx === -1) { send(ws, { type: 'join-error', reason: 'room-full' }); return; }
        room.seats[seatIdx] = ws;
        room.names[seatIdx] = safeName(msg.name, 'Player ' + (seatIdx + 1));
        ws.roomCode = code;
        ws.seat = seatIdx;
        send(ws, { type: 'joined', code, seat: seatIdx, maxPlayers: room.maxPlayers, buyIn: room.buyIn });
        broadcastRoster(room);
        if (room.seats.every((s) => s)) broadcastAll(room, { type: 'room-full' });
        break;
      }

      // Classic 2-player relay: forward to whichever side isn't me. Unchanged.
      // Tournament relay: a guest can only ever reach the host this way — the
      // host uses relay-to / relay-all (below) to reach a specific guest or
      // everyone, since each seat needs its own customized view.
      case 'relay': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        if (room.maxPlayers === 2) {
          const peer = room.seats[0] === ws ? room.seats[1] : room.seats[0];
          send(peer, { type: 'relay', payload: msg.payload });
        } else if (ws.seat !== 0) {
          send(room.seats[0], { type: 'relay', payload: msg.payload, fromSeat: ws.seat });
        }
        break;
      }

      // Tournament only — host sends a message to exactly one seat.
      case 'relay-to': {
        const room = rooms.get(ws.roomCode);
        if (!room || room.maxPlayers === 2 || ws.seat !== 0) return;
        const target = room.seats[msg.seat];
        send(target, { type: 'relay', payload: msg.payload });
        break;
      }

      // Tournament only — host sends a message to every other seat.
      case 'relay-all': {
        const room = rooms.get(ws.roomCode);
        if (!room || room.maxPlayers === 2 || ws.seat !== 0) return;
        broadcastAll(room, { type: 'relay', payload: msg.payload }, 0);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const mySeat = ws.seat;

    if (room.maxPlayers === 2) {
      const peer = room.seats[0] === ws ? room.seats[1] : room.seats[0];
      room.seats[mySeat] = null;
      send(peer, { type: 'peer-left' });
      cleanupIfEmpty(room.code);
      return;
    }

    room.seats[mySeat] = null;
    if (mySeat === 0) {
      // The host leaving ends the tournament — there's no game state left
      // to relay from without them.
      broadcastAll(room, { type: 'host-left' });
      rooms.delete(room.code);
    } else {
      room.names[mySeat] = null;
      // The host decides what a departed seat means for the tournament
      // (commonly: treat it as an elimination) — the server just reports it.
      send(room.seats[0], { type: 'seat-left', seat: mySeat });
      broadcastRoster(room);
      cleanupIfEmpty(room.code);
    }
  });
});

// Rooms nobody ever finished filling get swept out after 30 minutes so
// memory doesn't grow forever on a long-running free-tier instance.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of rooms) {
    const full = room.seats.every((s) => s);
    if (!full && room.createdAt < cutoff) rooms.delete(code);
  }
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`njuga-casino relay listening on :${PORT}`);
});
