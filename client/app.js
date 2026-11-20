const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let me = null;
let state = { queue: [], current: null, pcState: "unknown", agentOnline: false };
let socket = null;
let timerInterval = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  return res.json();
}

function fmtMs(ms) {
  if (ms >= Number.MAX_SAFE_INTEGER / 2) return "∞";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function render() {
  const login = $("#login-panel");
  const app = $("#app-panel");
  const userArea = $("#user-area");

  if (!me) {
    login.classList.remove("hidden");
    app.classList.add("hidden");
    userArea.innerHTML = "";
    const params = new URLSearchParams(location.search);
    if (params.get("error") === "not_whitelisted") {
      $("#error-msg").textContent = "Your Gmail is not on the whitelist.";
      $("#error-msg").classList.remove("hidden");
    }
    return;
  }

  login.classList.add("hidden");
  app.classList.remove("hidden");
  userArea.innerHTML = `
    <div class="user-chip">
      ${me.photo ? `<img src="${me.photo}" alt="">` : ""}
      <span>${me.name}${me.isOwner ? " · owner" : ""}</span>
      <a href="/auth/logout">logout</a>
    </div>`;

  // pills
  const pc = $("#pc-pill");
  const ag = $("#agent-pill");
  pc.textContent = `PC: ${state.pcState}`;
  pc.className = "pill " + (state.pcState === "ready" || state.pcState === "awake" ? "good" : state.pcState === "sleeping" ? "warn" : "");
  ag.textContent = `Agent: ${state.agentOnline ? "online" : "offline"}`;
  ag.className = "pill " + (state.agentOnline ? "good" : "bad");

  // session
  const isMine = state.current && state.current.email === me.email;
  const sessionCard = $("#session-card");
  if (isMine) {
    sessionCard.classList.remove("hidden");
    $("#session-info").innerHTML = `<p>Playing as <strong>${me.name}</strong></p>`;
    startTimer(state.current.endsAt);
  } else {
    sessionCard.classList.add("hidden");
    stopTimer();
  }

  // queue
  const list = $("#queue-list");
  if (!state.queue.length && !state.current) {
    list.innerHTML = `<li style="color:var(--muted)">Queue is empty</li>`;
  } else {
    list.innerHTML = "";
    if (state.current) {
      const li = document.createElement("li");
      li.className = state.current.isOwner ? "owner" : "";
      li.innerHTML = `<span class="pos">▶</span><span class="name">${state.current.name}</span><span>playing</span>`;
      list.appendChild(li);
    }
    state.queue.forEach((q, i) => {
      const li = document.createElement("li");
      if (q.isOwner) li.classList.add("owner");
      li.innerHTML = `<span class="pos">${i + 1}</span><span class="name">${q.name}</span><span>${q.email === me.email ? "you" : ""}</span>`;
      list.appendChild(li);
    });
  }

  const inQueue = state.queue.some((q) => q.email === me.email);
  const playing = state.current?.email === me.email;
  $("#btn-join").disabled = inQueue || playing;
  $("#btn-leave").disabled = !inQueue;

  // owner
  if (me.isOwner) {
    $("#owner-panel").classList.remove("hidden");
  }
}

function startTimer(endsAt) {
  stopTimer();
  const tick = () => {
    const left = endsAt - Date.now();
    $("#timer").textContent = fmtMs(left);
    if (left <= 0 && endsAt < Number.MAX_SAFE_INTEGER / 2) {
      $("#timer").textContent = "00:00";
    }
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

async function loadMe() {
  const data = await api("/api/me");
  me = data.user;
  render();
  if (me) {
    socket = io({ withCredentials: true });
    socket.emit("identify", me.email);
    socket.on("state", (s) => {
      state = s;
      render();
    });
    socket.on("session_ready", (info) => {
      $("#creds").classList.remove("hidden");
      $("#rd-id").textContent = info.rustdeskId || "(set RUSTDESK_ID on server)";
      $("#rd-pass").textContent = info.rustdeskPassword || "(set RUSTDESK_PASSWORD)";
      if (info.endsAt) startTimer(info.endsAt);
    });
    socket.on("session_ended", () => {
      $("#creds").classList.add("hidden");
      alert("Session ended.");
    });
  }
}

$("#btn-join")?.addEventListener("click", async () => {
  await api("/api/queue/join", { method: "POST" });
});
$("#btn-leave")?.addEventListener("click", async () => {
  await api("/api/queue/leave", { method: "POST" });
});
$("#btn-leave-session")?.addEventListener("click", async () => {
  await api("/api/queue/leave", { method: "POST" });
});

$("#btn-add-wl")?.addEventListener("click", async () => {
  const email = $("#wl-email").value.trim();
  if (!email) return;
  const data = await api("/api/admin/whitelist", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  renderWhitelist(data.emails);
  $("#wl-email").value = "";
});

async function loadWhitelist() {
  if (!me?.isOwner) return;
  const data = await api("/api/admin/whitelist");
  renderWhitelist(data.emails);
}

function renderWhitelist(emails) {
  const ul = $("#wl-list");
  ul.innerHTML = emails
    .map(
      (e) =>
        `<li><span>${e}</span>${
          e === me.email
            ? "<span>owner</span>"
            : `<button data-email="${e}">remove</button>`
        }</li>`
    )
    .join("");
  ul.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const data = await api(`/api/admin/whitelist/${btn.dataset.email}`, {
        method: "DELETE",
      });
      renderWhitelist(data.emails);
    });
  });
}

loadMe().then(loadWhitelist);