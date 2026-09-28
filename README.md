# NJUGA/CASINO Online Rooms — relay server

This is the missing piece for "Online Rooms". It does **not** know how the
card game is played — it only lets one phone create a room (gets back a
5-character code like `AZRKH`), lets a second phone join with that code, and
then relays whatever JSON messages the two phones send each other. The actual
game keeps running on the phone that created the room, exactly the way it
already runs against the computer opponent today — the messages relayed here
just take the place of that AI.

## Run it locally first (to test on your own network)

```bash
cd server
npm install
npm start
```

You'll see:

```
njuga-casino relay listening on :8787
```

Leave that running. Anyone on the same Wi-Fi network can now reach it at
`ws://<your-computer's-LAN-IP>:8787` — useful for testing with two phones
before you deploy it publicly.

## Deploy it for free (Render.com)

This runs 24/7 on the internet so friends can play from anywhere, not just
your Wi-Fi.

1. Put the `server/` folder in its own GitHub repository (or push the whole
   project and point Render at the `server` subfolder — see step 4).
2. Go to [render.com](https://render.com) and sign up (free).
3. Click **New +** → **Web Service**, connect your GitHub repo.
4. If `server/` is a subfolder of a bigger repo, set **Root Directory** to
   `server`.
5. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Click **Create Web Service**. After it deploys, Render gives you a URL
   like `https://njuga-casino-relay.onrender.com`.
7. Your app connects to the WebSocket version of that same address:
   `wss://njuga-casino-relay.onrender.com` (note `wss://`, not `https://`).

**Free-tier note:** Render's free web services spin down after a period of
inactivity and take a few seconds to wake up on the next connection. That
means the very first person to create a room after a quiet period might see
a short delay before it connects. This isn't a bug — it's normal for a free
tier server. Render's paid tier or another host (Railway, Fly.io) removes
that delay if it ever becomes annoying.

## Message protocol (for the client-side wiring)

| Direction | Message | Meaning |
|---|---|---|
| client → server | `{type:'create'}` | Make a new room. |
| server → client | `{type:'created', code}` | Here's your room code — show it to the host. |
| client → server | `{type:'join', code}` | Try to join a room by code. |
| server → client | `{type:'joined', code}` | You're in. |
| server → client | `{type:'join-error', reason}` | `'no-such-room'` or `'room-full'`. |
| server → host | `{type:'peer-joined'}` | A second player connected — safe to start the match. |
| either → server | `{type:'relay', payload:{...}}` | Forwarded verbatim to the other player. |
| server → either | `{type:'relay', payload:{...}}` | A message from the other player. |
| server → either | `{type:'peer-left'}` | The other player disconnected. |

The app is now wired to this server (see `www/online.js`). Put your server's `wss://` address on the `DEFAULT_SERVER_URL` line at the top of that file, or type it into the app under Online Rooms > Server address.
