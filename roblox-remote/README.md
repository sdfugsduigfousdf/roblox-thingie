# Roblox Remote Play Queue

Self-hosted remote desktop queue for one Roblox PC.

## What it does

- Google login only (Gmail whitelist)
- Owner email has unlimited time
- Everyone else gets 20 minutes then kicked
- FIFO queue
- 3 minutes idle → PC sleeps (saves power)
- Next person in queue wakes PC, enters PIN 2231, starts Proton VPN, launches Roblox
- Session is limited to Roblox only (agent enforces)

## Stack

| Piece | Role |
|-------|------|
| Web app (Node + Express + Socket.IO) | Login, queue, status, live timer |
| Agent (Windows PowerShell + C#) | Wake, unlock, VPN, Roblox, sleep, kill session |
| RustDesk (self-hosted) | Actual remote desktop stream |

## Quick start

### 1. Host PC (the one that runs Roblox)

1. Install RustDesk client → point it at your self-hosted server (or public for testing).
2. Install Proton VPN desktop app and log in once.
3. Copy the `agent` folder to the PC.
4. Edit `agent/config.json` (PIN, paths, emails).
5. Run `agent/RobloxAgent.exe` as Administrator (or the PowerShell launcher).
6. Keep the agent running in the background.

### 2. Web server (can be the same PC or a cheap VPS)

```bash
cd server
cp .env.example .env
# fill GOOGLE_CLIENT_ID / SECRET and OWNER_EMAIL
npm install
npm start
```

Open https://your-domain (or localhost:3000).

### 3. Google OAuth

1. Google Cloud Console → Credentials → OAuth 2.0 Client ID (Web).
2. Authorized redirect URI: `https://your-domain/auth/google/callback`
3. Put Client ID + Secret in `.env`.

### 4. Whitelist

Edit `server/whitelist.json` or use the owner dashboard after first login.

Owner email is hard-coded as unlimited: `9675090@graniteschools.org`

## Config summary

```json
// agent/config.json
{
  "pin": "2231",
  "robloxPath": "C:\\Users\\...\\RobloxPlayerBeta.exe",
  "protonVpnPath": "C:\\Program Files\\Proton\\VPN\\ProtonVPN.Launcher.exe",
  "idleSleepMinutes": 3,
  "sessionMinutes": 20,
  "ownerEmail": "9675090@graniteschools.org",
  "serverUrl": "https://your-domain",
  "agentSecret": "change-me-long-random"
}
```

## Security notes

- Only whitelisted Gmails can join the queue.
- Agent only accepts commands signed with `agentSecret`.
- RustDesk password / ID should be rotated and only given after a queue slot is granted.
- The agent kills every process except Roblox + VPN + itself when a session starts.
- Sleep is S3 (modern standby) so wake-on-LAN / magic packet works.

## Files

```
roblox-remote/
├── server/          # Node web + queue + OAuth
├── agent/           # Windows agent
├── client/          # simple static front-end (served by server)
└── README.md
```

Delivered.