import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import cookieParser from "cookie-parser";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "9675090@graniteschools.org").toLowerCase();
const AGENT_SECRET = process.env.AGENT_SECRET || "change-me";
const SESSION_MINUTES = 20;
const IDLE_SLEEP_MINUTES = 3;

// ---------- whitelist ----------
function loadWhitelist() {
  const p = join(__dirname, "whitelist.json");
  if (!existsSync(p)) return new Set([OWNER_EMAIL]);
  const data = JSON.parse(readFileSync(p, "utf8"));
  return new Set((data.emails || []).map((e) => e.toLowerCase()));
}
function saveWhitelist(set) {
  writeFileSync(
    join(__dirname, "whitelist.json"),
    JSON.stringify({ emails: [...set] }, null, 2)
  );
}
let whitelist = loadWhitelist();

// ---------- queue state ----------
/** @type {{ id: string, email: string, name: string, joinedAt: number, isOwner: boolean }[]} */
let queue = [];
/** @type {null | { id: string, email: string, name: string, startedAt: number, endsAt: number, isOwner: boolean }} */
let currentSession = null;
let lastActivity = Date.now();
let pcState = "unknown"; // awake | sleeping | waking | ready
let agentOnline = false;
let lastAgentHeartbeat = 0;

function broadcast() {
  const payload = {
    queue: queue.map((q) => ({
      id: q.id,
      name: q.name,
      email: q.email,
      isOwner: q.isOwner,
      joinedAt: q.joinedAt,
    })),
    current: currentSession
      ? {
          id: currentSession.id,
          name: currentSession.name,
          email: currentSession.email,
          isOwner: currentSession.isOwner,
          startedAt: currentSession.startedAt,
          endsAt: currentSession.endsAt,
          remainingMs: Math.max(0, currentSession.endsAt - Date.now()),
        }
      : null,
    pcState,
    agentOnline,
    idleMs: Date.now() - lastActivity,
  };
  io.emit("state", payload);
}

// ---------- passport ----------
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "missing",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "missing",
      callbackURL: process.env.CALLBACK_URL || "http://localhost:3000/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      const email = (profile.emails?.[0]?.value || "").toLowerCase();
      if (!whitelist.has(email)) {
        return done(null, false, { message: "not_whitelisted" });
      }
      return done(null, {
        id: profile.id,
        email,
        name: profile.displayName || email.split("@")[0],
        photo: profile.photos?.[0]?.value || null,
        isOwner: email === OWNER_EMAIL,
      });
    }
  )
);

// ---------- middleware ----------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(join(__dirname, "../client")));

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: "login_required" });
}

function requireOwner(req, res, next) {
  if (req.user?.isOwner) return next();
  return res.status(403).json({ error: "owner_only" });
}

// ---------- auth routes ----------
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/?error=not_whitelisted",
    successRedirect: "/",
  })
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/");
  });
});

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user });
});

// ---------- queue API ----------
app.post("/api/queue/join", requireAuth, (req, res) => {
  const email = req.user.email;
  if (queue.some((q) => q.email === email) || currentSession?.email === email) {
    return res.status(400).json({ error: "already_in_queue_or_playing" });
  }
  const entry = {
    id: uuidv4(),
    email,
    name: req.user.name,
    joinedAt: Date.now(),
    isOwner: req.user.isOwner,
  };
  if (req.user.isOwner) {
    queue.unshift(entry); // owner jumps to front
  } else {
    queue.push(entry);
  }
  lastActivity = Date.now();
  tryStartNext();
  broadcast();
  res.json({ ok: true, position: queue.findIndex((q) => q.id === entry.id) + 1 });
});

app.post("/api/queue/leave", requireAuth, (req, res) => {
  const email = req.user.email;
  queue = queue.filter((q) => q.email !== email);
  if (currentSession?.email === email) {
    endSession("left");
  }
  broadcast();
  res.json({ ok: true });
});

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    queue,
    current: currentSession,
    pcState,
    agentOnline,
  });
});

// ---------- owner admin ----------
app.get("/api/admin/whitelist", requireAuth, requireOwner, (req, res) => {
  res.json({ emails: [...whitelist] });
});

app.post("/api/admin/whitelist", requireAuth, requireOwner, (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  if (!email.includes("@")) return res.status(400).json({ error: "bad_email" });
  whitelist.add(email);
  saveWhitelist(whitelist);
  res.json({ emails: [...whitelist] });
});

app.delete("/api/admin/whitelist/:email", requireAuth, requireOwner, (req, res) => {
  const email = req.params.email.toLowerCase();
  if (email === OWNER_EMAIL) return res.status(400).json({ error: "cannot_remove_owner" });
  whitelist.delete(email);
  saveWhitelist(whitelist);
  res.json({ emails: [...whitelist] });
});

// ---------- agent API (machine → server) ----------
function agentAuth(req, res, next) {
  const secret = req.headers["x-agent-secret"] || req.body?.secret;
  if (secret !== AGENT_SECRET) return res.status(401).json({ error: "bad_secret" });
  next();
}

app.post("/api/agent/heartbeat", agentAuth, (req, res) => {
  agentOnline = true;
  lastAgentHeartbeat = Date.now();
  if (req.body.pcState) pcState = req.body.pcState;
  if (req.body.activity) lastActivity = Date.now();
  res.json({
    command: pendingCommand,
    currentSession,
    queueLength: queue.length,
  });
  pendingCommand = null;
});

app.post("/api/agent/event", agentAuth, (req, res) => {
  const { type, detail } = req.body;
  if (type === "ready") {
    pcState = "ready";
    lastActivity = Date.now();
  } else if (type === "sleeping") {
    pcState = "sleeping";
  } else if (type === "session_ended") {
    endSession("agent");
  } else if (type === "activity") {
    lastActivity = Date.now();
  }
  broadcast();
  res.json({ ok: true });
});

let pendingCommand = null; // { type, payload }

function sendToAgent(cmd) {
  pendingCommand = cmd;
}

// ---------- session logic ----------
function tryStartNext() {
  if (currentSession) return;
  if (queue.length === 0) return;
  if (!agentOnline) return;

  const next = queue.shift();
  const isOwner = next.isOwner;
  const endsAt = isOwner ? Number.MAX_SAFE_INTEGER : Date.now() + SESSION_MINUTES * 60 * 1000;

  currentSession = {
    id: next.id,
    email: next.email,
    name: next.name,
    startedAt: Date.now(),
    endsAt,
    isOwner,
  };

  pcState = "waking";
  sendToAgent({
    type: "prepare_session",
    payload: {
      email: next.email,
      isOwner,
      pin: "2231",
      sessionMinutes: isOwner ? 0 : SESSION_MINUTES,
    },
  });

  // give connection info after short delay so agent can finish unlock
  setTimeout(() => {
    io.to(next.email).emit("session_ready", {
      rustdeskId: process.env.RUSTDESK_ID || "",
      rustdeskPassword: process.env.RUSTDESK_PASSWORD || "",
      endsAt: currentSession?.endsAt,
    });
  }, 8000);

  broadcast();
}

function endSession(reason) {
  if (!currentSession) return;
  const ended = currentSession;
  currentSession = null;
  sendToAgent({ type: "end_session", payload: { reason } });
  io.to(ended.email).emit("session_ended", { reason });
  lastActivity = Date.now();
  tryStartNext();
  broadcast();
}

// ---------- timers ----------
setInterval(() => {
  // kick expired non-owner sessions
  if (currentSession && !currentSession.isOwner && Date.now() >= currentSession.endsAt) {
    endSession("timeout");
  }

  // agent timeout
  if (agentOnline && Date.now() - lastAgentHeartbeat > 45000) {
    agentOnline = false;
    broadcast();
  }

  // idle sleep
  if (
    !currentSession &&
    queue.length === 0 &&
    agentOnline &&
    pcState !== "sleeping" &&
    Date.now() - lastActivity > IDLE_SLEEP_MINUTES * 60 * 1000
  ) {
    sendToAgent({ type: "sleep" });
    pcState = "sleeping";
    broadcast();
  }

  // keep timers fresh for clients
  if (currentSession) broadcast();
}, 5000);

// ---------- sockets ----------
io.on("connection", (socket) => {
  socket.on("identify", (email) => {
    if (email) socket.join(email);
  });
  socket.emit("state", {
    queue,
    current: currentSession,
    pcState,
    agentOnline,
  });
});

httpServer.listen(PORT, () => {
  console.log(`Roblox Remote Queue listening on :${PORT}`);
  console.log(`Owner: ${OWNER_EMAIL}`);
});