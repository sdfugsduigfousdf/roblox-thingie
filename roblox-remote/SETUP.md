# Setup Guide — Roblox Remote Queue

## 1. Google OAuth (5 min)

1. Go to https://console.cloud.google.com/
2. Create a project → APIs & Services → Credentials
3. Create OAuth client ID → Web application
4. Authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback` (dev)
   - `https://yourdomain.com/auth/google/callback` (prod)
5. Copy Client ID + Client Secret into `server/.env`

## 2. Server

```bash
cd server
cp .env.example .env
# edit .env — fill GOOGLE_*, AGENT_SECRET, OWNER_EMAIL, RUSTDESK_ID, RUSTDESK_PASSWORD
npm install
npm start
```

Open http://localhost:3000 and sign in with `9675090@graniteschools.org`.

## 3. RustDesk (the actual remote stream)

### Option A — self-host (recommended)

On a Linux VPS (or the same Windows PC with Docker):

```bash
bash <(wget -qO- https://get.docker.com)
mkdir -p ~/rustdesk && cd ~/rustdesk
wget rustdesk.com/oss.yml -O compose.yml
docker compose up -d
```

Open ports: 21115-21117/tcp, 21116/udp.

Copy the public key from `data/id_ed25519.pub`.

On the **Roblox PC**:
- Install RustDesk
- Settings → Network → ID/Relay server = your VPS IP
- Key = contents of id_ed25519.pub
- Set a permanent password
- Enable unattended access

Put the RustDesk ID + password into `server/.env` as `RUSTDESK_ID` and `RUSTDESK_PASSWORD`.

### Option B — public RustDesk servers (quick test)

Just install RustDesk on the PC, note the ID + password, put them in `.env`.

## 4. Windows agent (the Roblox PC)

1. Edit `agent/config.json`
   - `serverUrl` → your server URL
   - `agentSecret` → same as server `.env`
   - `robloxPath` → full path to Roblox shortcut or exe
   - `protonVpnPath` → path to ProtonVPN launcher
   - `pin` → `2231`

2. Proton VPN: install, log in, connect once to a server you like. Enable **auto-connect on launch** in Proton settings.

3. Right-click `Start-Agent.bat` → Run as administrator.

4. Leave it running. It heartbeats every few seconds.

## 5. Whitelist friends

Sign in as owner → bottom panel → add Gmail addresses.
Only those emails can join the queue.

## 6. How a session works

1. Friend signs in with Gmail → Join queue
2. When it's their turn the agent:
   - wakes the PC (if sleeping)
   - types PIN `2231`
   - starts Proton VPN
   - launches Roblox
3. Web UI shows RustDesk ID + password
4. They connect with RustDesk client
5. After 20 min (or Leave) the agent closes Roblox and the next person starts
6. Owner (`9675090@graniteschools.org`) never times out
7. If nobody is in queue for 3 minutes → PC sleeps

## 7. Hardening tips

- Change `AGENT_SECRET` to a long random string
- Put the web server behind HTTPS (Caddy / nginx)
- Restrict RustDesk password to change every few days
- Firewall: only open RustDesk ports to the internet, keep the queue server on a domain you control
- Agent must stay elevated so it can sleep the machine and send keys to the lock screen

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent offline | Check serverUrl + agentSecret match, run as admin |
| PIN not typed | Lock screen must be visible; disable Windows Hello face/fingerprint for the account or test SendKeys manually |
| Roblox not launching | Update `robloxPath` in config.json to the real .exe or .lnk |
| VPN not connecting | Enable "Connect on launch" inside Proton VPN app |
| Sleep doesn't wake | Enable Wake-on-LAN in BIOS + Windows network adapter power settings |