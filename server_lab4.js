const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const http = require('http');

const { authMiddleware } = require('./middleware/auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const usersFile = path.join(DATA_DIR, 'users.json');
const tasksFile = path.join(DATA_DIR, 'tasks.json');
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES = '2h';

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || def; } catch { return def; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

if (!fs.existsSync(usersFile)) writeJson(usersFile, []);
if (!fs.existsSync(tasksFile)) writeJson(tasksFile, []);

let users = readJson(usersFile, []);
let tasks = readJson(tasksFile, []);

const app = express();
const server = http.createServer(app);

const { Server } = require('socket.io');
const io = new Server(server, {
  // allow any origin for development; change in production as needed
  cors: { origin: "*" }
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'client')));

// helpers: token extraction & verification
function tokenFromCookieString(cookie) {
  if (!cookie) return null;
  const parts = cookie.split(';').map(s => s.trim());
  for (const p of parts) {
    if (p.startsWith('token=')) return p.slice('token='.length);
  }
  return null;
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

function broadcastTasks() {
  tasks = readJson(tasksFile, []);
  io.emit('tasks:changed', tasks);
}

// SOCKET.IO handlers
io.on('connection', (socket) => {
  // attach user if handshake cookie contains a valid token
  const cookie = socket.handshake.headers.cookie;
  const token = tokenFromCookieString(cookie);
  if (token) {
    const u = verifyToken(token);
    if (u) socket.user = u;
  }

  // me - return current user info
  socket.on('me', (_, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.user) return ack({ status: 401, error: 'Unauthorized' });
    ack({ userId: socket.user.userId, email: socket.user.email });
  });

  // register
  socket.on('register', async (data, ack) => {
    if (typeof ack !== 'function') return;
    const { email, password } = data || {};
    if (!email || !password) return ack({ status: 400, error: 'Email and password required' });
    users = readJson(usersFile, []);
    if (users.find(u => u.email === email)) return ack({ status: 409, error: 'User exists' });
    const id = Date.now();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id, email, passwordHash };
    users.push(user);
    writeJson(usersFile, users);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    ack({ token });
  });

  // login
  socket.on('login', async (data, ack) => {
    if (typeof ack !== 'function') return;
    const { email, password } = data || {};
    users = readJson(usersFile, []);
    const user = users.find(u => u.email === email);
    if (!user) return ack({ status: 401, error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return ack({ status: 401, error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    ack({ token });
  });

  // logout
  socket.on('logout', (_, ack) => {
    if (typeof ack === 'function') ack({ ok: true });
  });

  // list tasks
  socket.on('tasks:list', (_, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.user) return ack({ status: 401, error: 'Unauthorized' });
    tasks = readJson(tasksFile, []);
    ack(tasks);
  });

  // create task (file expected as { originalname, data( base64 ) })
  socket.on('tasks:create', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.user) return ack({ status: 401, error: 'Unauthorized' });
    const { title, status = 'pending', dueDate = null, file } = data || {};
    if (!title) return ack({ status: 400, error: 'title required' });
    tasks = readJson(tasksFile, []);
    const task = { id: Date.now(), title, status, dueDate: dueDate || null, attachments: [] };
    if (file && file.data) {
      const filename = Date.now() + '-' + (file.originalname || 'file');
      const p = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(p, Buffer.from(file.data, 'base64'));
      task.attachments.push({ filename, originalname: file.originalname || filename });
    }
    tasks.push(task);
    writeJson(tasksFile, tasks);
    broadcastTasks();
    ack(task);
  });

  // update task
  socket.on('tasks:update', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.user) return ack({ status: 401, error: 'Unauthorized' });
    const { id, title, status, dueDate, file } = data || {};
    tasks = readJson(tasksFile, []);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return ack({ status: 404, error: 'not found' });
    if (title !== undefined) tasks[idx].title = title;
    if (status !== undefined) tasks[idx].status = status;
    if (dueDate !== undefined) tasks[idx].dueDate = dueDate || null;
    if (file && file.data) {
      const filename = Date.now() + '-' + (file.originalname || 'file');
      const p = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(p, Buffer.from(file.data, 'base64'));
      tasks[idx].attachments.push({ filename, originalname: file.originalname || filename });
    }
    writeJson(tasksFile, tasks);
    broadcastTasks();
    ack(tasks[idx]);
  });

  // delete task
  socket.on('tasks:delete', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.user) return ack({ status: 401, error: 'Unauthorized' });
    const { id } = data || {};
    tasks = readJson(tasksFile, []);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return ack({ status: 404, error: 'not found' });
    tasks.splice(idx, 1);
    writeJson(tasksFile, tasks);
    broadcastTasks();
    ack({ message: 'deleted' });
  });

}); // io.on('connection')

// download attachment via HTTP (protected)
app.get('/api/tasks/:id/files/:filename', authMiddleware(JWT_SECRET), (req, res) => {
  const { filename } = req.params;
  const p = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
  res.download(p);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));
