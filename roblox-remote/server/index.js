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
const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS || "9675090@graniteschools.org,ash316796@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const AGENT_SECRET = process.env.AGENT_SECRET || "change-me";
const IDLE_SLEEP_MINUTES = 3;

// Plans: higher priority number = served first; duration 0 = unlimited
const PLANS = {
  free: { name: "Free", price: 0, minutes: 15, priority: 0 },
  basic: { name: "Basic", price: 2, minutes: 15, priority: 10 },
  advanced: { name: "Advanced", price: 5, minutes: 30, priority: 20 },
  power: { name: "Power", price: 8, minutes: 60, priority: 30 },
  unlimited: { name: "Unlimited", price: 10, minutes: 120, priority: 40 },
  god: { name: "GOD", price: 20, minutes: 0, priority: 50 },
};

function loadJson(name, fallback) {
  const p = join(__dirname, name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(name, data) {
  writeFileSync(join(__dirname, name), JSON.stringify(data, null, 2));
}

let whitelist = new Set(
  (loadJson("whitelist.json", { emails: [...OWNER_EMAILS] }).emails || []).map((e) =>
    e.toLowerCase()
  )
);
OWNER_EMAILS.forEach((e) => whitelist.add(e));

// email -> plan key
let userPlans = loadJson("plans.json", {});

function isOwner(email) {
  return OWNER_EMAILS.has((email || "").toLowerCase());
}
function getPlan(email) {
  if (isOwner(email)) return { ...PLANS.god, key: "god", isOwner: true };
  const key = (userPlans[email.toLowerCase()] || "free").toLowerCase();
  const p = PLANS[key] || PLANS.free;
  return { ...p, key, isOwner: false };
}
function savePlans() {
  saveJson("plans.json", userPlans);
}
function saveWhitelist() {
  saveJson("whitelist.json", { emails: [...whitelist] });
}

let queue = [];
let currentSession = null;
let lastActivity = Date.now();
let pcState = "unknown";
let agentOnline = false;
let lastAgentHeartbeat = 0;
let pendingCommand = null;
let sleepDisabled = false; // owners can toggle; default allow short sleep but we wake hard

function sortQueue() {
  queue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.joinedAt - b.joinedAt;
  });
}

function broadcast() {
  const payload = {
    queue: queue.map((q) => ({
      id: q.id,
      name: q.name,
      email: q.email,
      isOwner: q.isOwner,
      plan: q.plan,
      priority: q.priority,
      minutes: q.minutes,
      joinedAt: q.joinedAt,
    })),
    current: currentSession
      ? {
          id: currentSession.id,
          name: currentSession.name,
          email: currentSession.email,
          isOwner: currentSession.isOwner,
          plan: currentSession.plan,
          startedAt: currentSession.startedAt,
          endsAt: currentSession.endsAt,
          remainingMs:
            currentSession.endsAt === Number.MAX_SAFE_INTEGER
              ? null
              : Math.max(0, currentSession.endsAt - Date.now()),
        }
      : null,
    pcState,
    agentOnline,
    idleMs: Date.now() - lastActivity,
    plans: PLANS,
    sleepDisabled,
  };
  io.emit("state", payload);
}

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
      const plan = getPlan(email);
      return done(null, {
        id: profile.id,
        email,
        name: profile.displayName || email.split("@")[0],
        photo: profile.photos?.[0]?.value || null,
        isOwner: isOwner(email),
        plan: plan.key,
        planMeta: plan,
      });
    }
  )
);

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

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/?error=not_whitelisted",
    successRedirect: "/",
  })
);
app.get("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  const plan = getPlan(req.user.email);
  res.json({
    user: {
      ...req.user,
      isOwner: isOwner(req.user.email),
      plan: plan.key,
      planMeta: plan,
    },
  });
});

app.get("/api/plans", (_req, res) => res.json({ plans: PLANS }));

app.post("/api/queue/join", requireAuth, (req, res) => {
  const email = req.user.email;
  if (queue.some((q) => q.email === email) || currentSession?.email === email) {
    return res.status(400).json({ error: "already_in_queue_or_playing" });
  }
  const plan = getPlan(email);
  const entry = {
    id: uuidv4(),
    email,
    name: req.user.name,
    joinedAt: Date.now(),
    isOwner: plan.isOwner,
    plan: plan.key,
    priority: plan.priority,
    minutes: plan.minutes,
  };
  queue.push(entry);
  sortQueue();
  lastActivity = Date.now();
  // wake PC if sleeping as soon as someone joins
  if (pcState === "sleeping" || pcState === "unknown") {
    sendToAgent({ type: "wake_only" });
  }
  tryStartNext();
  broadcast();
  res.json({ ok: true, position: queue.findIndex((q) => q.id === entry.id) + 1, plan: plan.key });
});

app.post("/api/queue/leave", requireAuth, (req, res) => {
  const email = req.user.email;
  queue = queue.filter((q) => q.email !== email);
  if (currentSession?.email === email) endSession("left");
  broadcast();
  res.json({ ok: true });
});

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    queue,
    current: currentSession,
    pcState,
    agentOnline,
    plans: PLANS,
    myPlan: getPlan(req.user.email),
  });
});

// ---------- owner admin ----------
app.get("/api/admin/whitelist", requireAuth, requireOwner, (req, res) => {
  res.json({ emails: [...whitelist], owners: [...OWNER_EMAILS], plans: userPlans });
});

app.post("/api/admin/whitelist", requireAuth, requireOwner, (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  if (!email.includes("@")) return res.status(400).json({ error: "bad_email" });
  whitelist.add(email);
  saveWhitelist();
  res.json({ emails: [...whitelist] });
});

app.delete("/api/admin/whitelist/:email", requireAuth, requireOwner, (req, res) => {
  const email = req.params.email.toLowerCase();
  if (OWNER_EMAILS.has(email)) return res.status(400).json({ error: "cannot_remove_owner" });
  whitelist.delete(email);
  delete userPlans[email];
  saveWhitelist();
  savePlans();
  res.json({ emails: [...whitelist] });
});

app.post("/api/admin/plan", requireAuth, requireOwner, (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const plan = (req.body.plan || "free").toLowerCase();
  if (!email.includes("@")) return res.status(400).json({ error: "bad_email" });
  if (!PLANS[plan]) return res.status(400).json({ error: "bad_plan", plans: Object.keys(PLANS) });
  if (OWNER_EMAILS.has(email)) return res.status(400).json({ error: "owners_are_god" });
  whitelist.add(email);
  userPlans[email] = plan;
  saveWhitelist();
  savePlans();
  // refresh priority if already in queue
  for (const q of queue) {
    if (q.email === email) {
      const p = getPlan(email);
      q.plan = p.key;
      q.priority = p.priority;
      q.minutes = p.minutes;
    }
  }
  sortQueue();
  broadcast();
  res.json({ ok: true, email, plan, plans: userPlans });
});

app.post("/api/admin/sleep", requireAuth, requireOwner, (req, res) => {
  sleepDisabled = !!req.body.disabled;
  res.json({ sleepDisabled });
});

// ---------- agent ----------
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
    sleepDisabled,
  });
  pendingCommand = null;
});

app.post("/api/agent/event", agentAuth, (req, res) => {
  const { type } = req.body;
  if (type === "ready") {
    pcState = "ready";
    lastActivity = Date.now();
  } else if (type === "sleeping") {
    pcState = "sleeping";
  } else if (type === "session_ended") {
    endSession("agent");
  } else if (type === "activity") {
    lastActivity = Date.now();
  } else if (type === "awake") {
    pcState = "awake";
  }
  broadcast();
  res.json({ ok: true });
});

function sendToAgent(cmd) {
  pendingCommand = cmd;
}

function tryStartNext() {
  if (currentSession) return;
  if (queue.length === 0) return;
  if (!agentOnline) return;

  sortQueue();
  const next = queue.shift();
  const plan = getPlan(next.email);
  const endsAt =
    plan.minutes === 0 || plan.isOwner
      ? Number.MAX_SAFE_INTEGER
      : Date.now() + plan.minutes * 60 * 1000;

  currentSession = {
    id: next.id,
    email: next.email,
    name: next.name,
    startedAt: Date.now(),
    endsAt,
    isOwner: plan.isOwner,
    plan: plan.key,
    minutes: plan.minutes,
  };

  pcState = "waking";
  sendToAgent({
    type: "prepare_session",
    payload: {
      email: next.email,
      isOwner: plan.isOwner,
      plan: plan.key,
      sessionMinutes: plan.minutes,
    },
  });

  setTimeout(() => {
    io.to(next.email).emit("session_ready", {
      rustdeskId: process.env.RUSTDESK_ID || "",
      rustdeskPassword: process.env.RUSTDESK_PASSWORD || "",
      endsAt: currentSession?.endsAt,
      plan: plan.key,
      minutes: plan.minutes,
    });
  }, 8000);

  lastActivity = Date.now();
  broadcast();
}

function endSession(reason) {
  if (!currentSession) return;
  const ended = currentSession;
  currentSession = null;
  sendToAgent({ type: "end_session", payload: { reason } });
  io.to(ended.email).emit("session_ended", { reason });
  lastActivity = Date.now();
  broadcast();
  setTimeout(tryStartNext, 1500);
}

// timers
setInterval(() => {
  if (Date.now() - lastAgentHeartbeat > 45000) agentOnline = false;

  if (currentSession && currentSession.endsAt !== Number.MAX_SAFE_INTEGER) {
    if (Date.now() >= currentSession.endsAt) {
      endSession("time_up");
    }
  }

  // idle sleep only if no queue, no session, and sleep not disabled
  if (
    !sleepDisabled &&
    !currentSession &&
    queue.length === 0 &&
    agentOnline &&
    pcState !== "sleeping" &&
    Date.now() - lastActivity > IDLE_SLEEP_MINUTES * 60 * 1000
  ) {
    sendToAgent({ type: "sleep" });
  }

  // if someone is waiting and PC is sleeping, keep requesting wake
  if (queue.length > 0 && (pcState === "sleeping" || pcState === "unknown")) {
    sendToAgent({ type: "wake_only" });
  }

  broadcast();
}, 5000);

io.on("connection", (socket) => {
  socket.on("identify", (email) => {
    if (email) socket.join(String(email).toLowerCase());
  });
  socket.emit("state", {
    queue,
    current: currentSession,
    pcState,
    agentOnline,
    plans: PLANS,
    sleepDisabled,
  });
});

httpServer.listen(PORT, () => {
  console.log(`Roblox Remote Queue listening on :${PORT}`);
  console.log(`Owners: ${[...OWNER_EMAILS].join(", ")}`);
});
