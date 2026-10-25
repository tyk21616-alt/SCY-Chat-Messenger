const $ = id => document.getElementById(id);
const state = { me: null, users: [], active: null, messages: [], socket: null, image: null, avatar: null, register: false, unread: new Set() };
const initials = name => (name || "?").trim().slice(0, 1).toUpperCase();
function avatarSrc(user) { return user && user.avatar ? user.avatar : ""; }
function setAvatar(el, user) {
  if (!user) { el.removeAttribute("src"); el.classList.add("avatar-fallback"); el.alt = ""; el.style.background = "linear-gradient(135deg,#7f65ff,#4d94ff)"; return; }
  el.alt = user.displayName || user.username;
  if (user.avatar) el.src = user.avatar;
  else {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="g"><stop stop-color="#a77bff"/><stop offset="1" stop-color="#4b95ff"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="62" text-anchor="middle" font-family="Arial" font-size="46" font-weight="700" fill="white">${initials(user.displayName || user.username)}</text></svg>`;
    el.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || "Что-то пошло не так.");
  return data;
}
function toast(text) { const t = $("toast"); t.textContent = text; t.classList.remove("hidden"); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), 2800); }
function authMode(register) {
  state.register = register;
  $("authTitle").textContent = register ? "Создай аккаунт" : "С возвращением";
  $("authSub").textContent = register ? "Присоединяйся к SCY Chat" : "Войди, чтобы продолжить общение";
  $("displayNameField").classList.toggle("hidden", !register);
  $("password").autocomplete = register ? "new-password" : "current-password";
  $("authSubmit").textContent = register ? "Зарегистрироваться" : "Войти";
  $("switchText").textContent = register ? "Уже есть аккаунт?" : "Нет аккаунта?";
  $("switchMode").textContent = register ? "Войти" : "Зарегистрироваться";
  $("authError").textContent = "";
}
$("switchMode").onclick = () => authMode(!state.register);
$("authForm").onsubmit = async e => {
  e.preventDefault(); $("authError").textContent = "";
  const body = { username: $("username").value.trim(), password: $("password").value };
  if (state.register) body.displayName = $("displayName").value.trim() || body.username;
  try {
    const data = await api("/api/" + (state.register ? "register" : "login"), { method: "POST", body: JSON.stringify(body) });
    state.me = data.user; await enterApp();
  } catch (err) { $("authError").textContent = err.message; }
};
async function boot() {
  try { const data = await api("/api/me"); if (data.user) { state.me = data.user; await enterApp(); } else showAuth(); }
  catch { showAuth(); }
}
function showAuth() { $("app").classList.add("hidden"); $("authView").classList.remove("hidden"); }
async function enterApp() {
  $("authView").classList.add("hidden"); $("app").classList.remove("hidden");
  $("myName").textContent = state.me.displayName; $("myHandle").textContent = "@" + state.me.username; setAvatar($("myAvatar"), state.me);
  await loadUsers();
  connectSocket();
}
async function loadUsers(q = "") {
  try {
    const data = await api("/api/users?q=" + encodeURIComponent(q));
    state.users = data.users;
    renderUsers();
    if (state.active) {
      const updated = state.users.find(u => u.id === state.active.id);
      if (updated) state.active = updated;
      renderHeader();
    }
  } catch (e) { toast(e.message); }
}
function renderUsers() {
  const list = $("userList");
  if (!state.users.length) {
    list.innerHTML = `<div class="welcome" style="padding:28px 10px"><p>${$("userSearch").value ? "Никого не нашли." : "Пока здесь никого нет. Создай второй аккаунт в другом браузере, чтобы проверить чат."}</p></div>`;
    return;
  }
  list.innerHTML = state.users.map(u => `<button class="user-item ${state.active && state.active.id === u.id ? "active" : ""}" data-id="${u.id}">
    <img class="avatar" alt=""><div class="user-copy"><b>${escapeHtml(u.displayName)}</b><small>@${escapeHtml(u.username)}${state.unread.has(u.id) ? " · новое сообщение" : ""}</small></div></button>`).join("");
  [...list.querySelectorAll(".user-item")].forEach((el, i) => {
    setAvatar(el.querySelector("img"), state.users[i]);
    el.onclick = () => openChat(state.users[i]);
  });
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function renderHeader() {
  if (!state.active) return;
  setAvatar($("chatAvatar"), state.active);
  $("chatName").textContent = state.active.displayName;
  $("chatHandle").textContent = "@" + state.active.username;
  $("messageInput").disabled = false; $("sendBtn").disabled = false;
}
async function openChat(user) {
  state.active = user; state.unread.delete(user.id); renderUsers(); renderHeader();
  if (window.innerWidth <= 720) $("app").classList.remove("show-list");
  $("messages").innerHTML = `<div class="day-label">ИСТОРИЯ СООБЩЕНИЙ</div>`;
  try {
    const data = await api("/api/messages/" + encodeURIComponent(user.id));
    if (!state.active || state.active.id !== user.id) return;
    state.messages = data.messages; renderMessages();
  } catch (e) { toast(e.message); }
  $("messageInput").focus();
}
function renderMessages() {
  const area = $("messages");
  if (!state.active) return;
  area.innerHTML = `<div class="day-label">ЛИЧНАЯ ПЕРЕПИСКА</div>` + state.messages.map(m => {
    const mine = m.senderId === state.me.id;
    const who = mine ? state.me : state.active;
    const time = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="message-row ${mine ? "mine" : ""}">${mine ? "" : '<img class="avatar" alt="">'}<div class="bubble">${m.image ? `<img class="message-image" src="${m.image}" alt="Изображение в сообщении">` : ""}${m.text ? `<div class="bubble-text">${escapeHtml(m.text)}</div>` : ""}<div class="bubble-meta">${time}${mine ? " ✓" : ""}</div></div></div>`;
  }).join("");
  const incomingAvatars = area.querySelectorAll(".message-row:not(.mine) .avatar");
  incomingAvatars.forEach(img => setAvatar(img, state.active));
  area.scrollTop = area.scrollHeight;
}
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();
  state.socket.on("connect_error", () => toast("Не удалось подключиться к live-серверу."));
  state.socket.on("message:new", m => {
    if (state.active && m.senderId === state.active.id) {
      state.messages.push(m); renderMessages();
    } else {
      state.unread.add(m.senderId); renderUsers();
      toast("Новое сообщение");
    }
    playSound();
  });
  state.socket.on("profile:updated", u => {
    if (u.id === state.me.id) { state.me = u; $("myName").textContent = u.displayName; $("myHandle").textContent = "@" + u.username; setAvatar($("myAvatar"), u); }
    const idx = state.users.findIndex(x => x.id === u.id);
    if (idx >= 0) state.users[idx] = u;
    if (state.active && state.active.id === u.id) state.active = u;
    renderUsers(); if (state.active && state.active.id === u.id) renderHeader();
  });
}
function playSound() {
  // Short synthesized notification tone; no external audio file is required.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.setValueAtTime(740, ctx.currentTime);
    osc.frequency.setValueAtTime(990, ctx.currentTime + .09);
    gain.gain.setValueAtTime(.0001, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.12, ctx.currentTime + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .22);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .23);
    osc.onended = () => ctx.close();
  } catch {}
}
$("userSearch").addEventListener("input", () => {
  clearTimeout(loadUsers.timer);
  loadUsers.timer = setTimeout(() => loadUsers($("userSearch").value.trim()), 220);
});
$("newChatBtn").onclick = () => { $("userSearch").focus(); $("userSearch").placeholder = "Введи имя пользователя..."; };
$("logoutBtn").onclick = async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  if (state.socket) state.socket.disconnect();
  state.me = null; state.active = null; state.users = []; state.messages = [];
  $("app").classList.add("hidden"); showAuth(); $("password").value = "";
};
$("mobileBack").onclick = () => $("app").classList.add("show-list");
$("messageForm").onsubmit = async e => {
  e.preventDefault();
  if (!state.active) return toast("Сначала выбери чат.");
  const input = $("messageInput"), text = input.value.trim();
  if (!text && !state.image) return;
  const payload = { recipientId: state.active.id, text, image: state.image };
  $("sendBtn").disabled = true;
  try {
    const data = await api("/api/messages", { method: "POST", body: JSON.stringify(payload) });
    if (state.active && state.active.id === payload.recipientId) { state.messages.push(data.message); renderMessages(); }
    input.value = ""; input.style.height = "auto"; clearImage();
  } catch (err) { toast(err.message); }
  finally { $("sendBtn").disabled = !state.active; }
};
$("messageInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("messageForm").requestSubmit(); }
});
$("messageInput").addEventListener("input", e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; });
$("attachBtn").onclick = () => { if (!state.active) return toast("Сначала выбери чат."); $("imageInput").click(); };
$("imageInput").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Выбери файл изображения.");
  if (file.size > 2.5 * 1024 * 1024) { e.target.value = ""; return toast("Изображение должно быть меньше 2.5 МБ."); }
  const reader = new FileReader();
  reader.onload = () => { state.image = reader.result; $("previewImg").src = state.image; $("imagePreview").classList.remove("hidden"); };
  reader.readAsDataURL(file);
};
function clearImage() { state.image = null; $("imageInput").value = ""; $("imagePreview").classList.add("hidden"); $("previewImg").removeAttribute("src"); }
$("removeImage").onclick = clearImage;
$("profileBtn").onclick = () => {
  $("profileName").value = state.me.displayName; state.avatar = state.me.avatar;
  setAvatar($("profileAvatarPreview"), state.me); $("profileError").textContent = ""; $("profileModal").classList.remove("hidden");
};
$("closeProfile").onclick = () => $("profileModal").classList.add("hidden");
$("avatarInput").onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Выбери изображение.");
  if (file.size > 2.5 * 1024 * 1024) { e.target.value = ""; return toast("Аватар должен быть меньше 2.5 МБ."); }
  const reader = new FileReader();
  reader.onload = () => { state.avatar = reader.result; setAvatar($("profileAvatarPreview"), { displayName: $("profileName").value || state.me.displayName, username: state.me.username, avatar: state.avatar }); };
  reader.readAsDataURL(file);
};
$("profileName").addEventListener("input", () => setAvatar($("profileAvatarPreview"), { displayName: $("profileName").value || state.me.displayName, username: state.me.username, avatar: state.avatar }));
$("profileForm").onsubmit = async e => {
  e.preventDefault(); $("profileError").textContent = "";
  try {
    const data = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: $("profileName").value.trim(), avatar: state.avatar }) });
    state.me = data.user; $("myName").textContent = state.me.displayName; $("myHandle").textContent = "@" + state.me.username; setAvatar($("myAvatar"), state.me);
    $("profileModal").classList.add("hidden"); toast("Профиль обновлён.");
  } catch (err) { $("profileError").textContent = err.message; }
};
boot();
