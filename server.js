const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "scy-chat.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, display_name TEXT NOT NULL,
  avatar TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', image_data TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);
`);

const SQLiteStore = SQLiteStoreFactory(session);
const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR, table: "sessions" }),
  secret: process.env.SESSION_SECRET || "change-this-secret-before-public-deployment-" + crypto.randomBytes(16).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});
app.use(express.json({ limit: "7mb" }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const publicUser = u => ({
  id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar || null
});
const getUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const getUserByUsername = db.prepare("SELECT * FROM users WHERE username = ?");
const currentUser = req => req.session.userId ? getUserById.get(req.session.userId) : null;
const requireAuth = (req, res, next) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Сначала войдите в аккаунт." });
  req.user = user; next();
};

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || username).trim().slice(0, 32);
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Имя пользователя: 3–20 символов, латиница, цифры и _." });
  if (password.length < 8 || password.length > 128)
    return res.status(400).json({ error: "Пароль должен содержать от 8 до 128 символов." });
  if (!displayName) return res.status(400).json({ error: "Укажите отображаемое имя." });
  if (getUserByUsername.get(username)) return res.status(409).json({ error: "Это имя пользователя уже занято." });
  try {
    const id = uuid();
    const hash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (id, username, password_hash, display_name, avatar, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .run(id, username, hash, displayName, Date.now());
    req.session.userId = id;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: "Не удалось создать сессию." });
      res.json({ user: publicUser(getUserById.get(id)) });
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "Ошибка регистрации." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = getUserByUsername.get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Неверное имя пользователя или пароль." });
  req.session.userId = user.id;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: "Не удалось создать сессию." });
    res.json({ user: publicUser(user) });
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/users", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 40);
  const users = q
    ? db.prepare("SELECT * FROM users WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT 50")
      .all(req.user.id, `%${q}%`, `%${q}%`)
    : db.prepare("SELECT * FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 50").all(req.user.id);
  res.json({ users: users.map(publicUser) });
});

app.patch("/api/profile", requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || "").trim().slice(0, 32);
  const avatar = req.body.avatar == null || req.body.avatar === "" ? null : String(req.body.avatar);
  if (!displayName) return res.status(400).json({ error: "Имя не может быть пустым." });
  if (avatar && (!avatar.startsWith("data:image/") || avatar.length > 3_500_000))
    return res.status(400).json({ error: "Аватар должен быть изображением размером до 2.5 МБ." });
  db.prepare("UPDATE users SET display_name = ?, avatar = ? WHERE id = ?").run(displayName, avatar, req.user.id);
  const user = getUserById.get(req.user.id);
  io.emit("profile:updated", publicUser(user));
  res.json({ user: publicUser(user) });
});

app.get("/api/messages/:otherId", requireAuth, (req, res) => {
  const other = getUserById.get(req.params.otherId);
  if (!other) return res.status(404).json({ error: "Пользователь не найден." });
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at ASC LIMIT 300
  `).all(req.user.id, other.id, other.id, req.user.id);
  res.json({ messages: rows.map(m => ({
    id: m.id, senderId: m.sender_id, recipientId: m.recipient_id,
    text: m.text, image: m.image_data || null, createdAt: m.created_at
  })) });
});

const insertMessage = db.prepare(
  "INSERT INTO messages (id, sender_id, recipient_id, text, image_data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
);
app.post("/api/messages", requireAuth, (req, res) => {
  const recipientId = String(req.body.recipientId || "");
  const recipient = getUserById.get(recipientId);
  const text = String(req.body.text || "").trim().slice(0, 4000);
  const image = req.body.image ? String(req.body.image) : null;
  if (!recipient || recipient.id === req.user.id) return res.status(400).json({ error: "Получатель не найден." });
  if (!text && !image) return res.status(400).json({ error: "Введите сообщение или выберите изображение." });
  if (image && (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(image) || image.length > 5_000_000))
    return res.status(400).json({ error: "Поддерживаются изображения до 3.5 МБ." });
  const message = { id: uuid(), senderId: req.user.id, recipientId, text, image, createdAt: Date.now() };
  insertMessage.run(message.id, message.senderId, message.recipientId, text, image, message.createdAt);
  io.to(`user:${recipientId}`).emit("message:new", message);
  io.to(`user:${req.user.id}`).emit("message:sent", message);
  res.json({ message });
});

io.use((socket, next) => sessionMiddleware(socket.request, socket.request.res || {}, next));
io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error("Unauthorized"));
  socket.userId = userId; next();
});
io.on("connection", socket => {
  socket.join(`user:${socket.userId}`);
  socket.on("disconnect", () => {});
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SCY Chat запущен: http://localhost:${PORT}`);
  console.log("Для доступа с других устройств в одной сети используйте локальный IP этого компьютера.");
});
