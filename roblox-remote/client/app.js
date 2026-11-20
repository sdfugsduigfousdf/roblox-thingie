const $ = (s) => document.querySelector(s);
let me = null;
let state = {};
const socket = io({ withCredentials: true });

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return r.json();
}

function fmtMs(ms) {
  if (ms == null) return "∞";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderPlans(plans) {
  const ul = $("#plan-list");
  if (!plans) return;
  ul.innerHTML = Object.entries(plans)
    .map(
      ([k, p]) =>
        `<li><strong>${p.name}</strong> — $${p.price} · ${
          p.minutes === 0 ? "no limit" : p.minutes + " min"
        } · prio ${p.priority}</li>`
    )
    .join("");
}

function render() {
  if (!me) {
    $("#login-card").classList.remove("hidden");
    $("#app").classList.add("hidden");
    return;
  }
  $("#login-card").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#uname").textContent = me.name || me.email;
  $("#uplan").textContent = me.isOwner
    ? "OWNER · GOD (no limit)"
    : `Plan: ${(me.plan || "free").toUpperCase()}`;
  if (me.photo) {
    $("#avatar").src = me.photo;
    $("#avatar").style.display = "block";
  }

  $("#pc-state").textContent = state.pcState || "—";
  $("#agent-state").textContent = state.agentOnline ? "online" : "offline";

  const mine =
    state.current && state.current.email === me.email ? state.current : null;
  if (mine) {
    $("#session-box").classList.remove("hidden");
    $("#timer").textContent =
      mine.remainingMs == null
        ? "Time remaining: unlimited"
        : `Time remaining: ${fmtMs(mine.remainingMs)}`;
    $("#rustdesk").textContent = `RustDesk ID: ${
      window.__rdId || "…"
    }  /  Password: ${window.__rdPw || "…"}`;
  } else {
    $("#session-box").classList.add("hidden");
  }

  const ql = $("#queue-list");
  ql.innerHTML = (state.queue || [])
    .map(
      (q, i) =>
        `<li>${i + 1}. ${q.name} <span class="tag">${(
          q.plan || ""
        ).toUpperCase()}</span>${q.isOwner ? " ★" : ""}</li>`
    )
    .join("") || "<li class='muted'>Queue empty</li>";

  $("#now-playing").textContent = state.current
    ? `Playing: ${state.current.name} (${(state.current.plan || "").toUpperCase()})`
    : "Nobody playing";

  if (me.isOwner) {
    $("#owner-panel").classList.remove("hidden");
  } else {
    $("#owner-panel").classList.add("hidden");
  }

  renderPlans(state.plans);
  if (typeof state.sleepDisabled === "boolean") {
    $("#chk-no-sleep").checked = state.sleepDisabled;
  }
}

async function boot() {
  const { user } = await api("/api/me");
  me = user;
  if (me) socket.emit("identify", me.email);
  render();
}

socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("session_ready", (info) => {
  window.__rdId = info.rustdeskId;
  window.__rdPw = info.rustdeskPassword;
  render();
  alert(
    `Session ready!\nRustDesk ID: ${info.rustdeskId}\nPassword: ${info.rustdeskPassword}\nOpen https://rustdesk.com/web`
  );
});

socket.on("session_ended", () => {
  window.__rdId = null;
  window.__rdPw = null;
  render();
});

$("#btn-join")?.addEventListener("click", async () => {
  await api("/api/queue/join", { method: "POST", body: "{}" });
});
$("#btn-leave")?.addEventListener("click", async () => {
  await api("/api/queue/leave", { method: "POST", body: "{}" });
});
$("#btn-leave-session")?.addEventListener("click", async () => {
  await api("/api/queue/leave", { method: "POST", body: "{}" });
});

$("#btn-add-wl")?.addEventListener("click", async () => {
  const email = $("#wl-email").value.trim();
  if (!email) return;
  await api("/api/admin/whitelist", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  $("#wl-email").value = "";
  loadAdmin();
});

$("#btn-set-plan")?.addEventListener("click", async () => {
  const email = $("#plan-email").value.trim();
  const plan = $("#plan-select").value;
  if (!email) return;
  const r = await api("/api/admin/plan", {
    method: "POST",
    body: JSON.stringify({ email, plan }),
  });
  if (r.error) alert(r.error);
  else alert(`Set ${email} → ${plan}`);
  loadAdmin();
});

$("#chk-no-sleep")?.addEventListener("change", async (e) => {
  await api("/api/admin/sleep", {
    method: "POST",
    body: JSON.stringify({ disabled: e.target.checked }),
  });
});

async function loadAdmin() {
  if (!me?.isOwner) return;
  const data = await api("/api/admin/whitelist");
  $("#wl-list").innerHTML = (data.emails || [])
    .map((e) => {
      const p = (data.plans && data.plans[e]) || (data.owners?.includes(e) ? "god" : "free");
      return `<li>${e} · ${p}</li>`;
    })
    .join("");
}

boot().then(loadAdmin);
setInterval(() => {
  if (state.current && state.current.remainingMs != null) {
    state.current.remainingMs = Math.max(0, state.current.remainingMs - 1000);
    render();
  }
}, 1000);
