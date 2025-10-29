const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const http = require('http');
const { buildSchema } = require('graphql');
const { graphqlHTTP } = require('express-graphql');
const WebSocket = require('ws');

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

// static client
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json({limit: '10mb'}));
app.use(cookieParser());

// simple token helpers
function tokenFromCookie(req) {
  return req.cookies && req.cookies.token;
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

// broadcast helper using ws server
let wss;
function broadcastTasks() {
  tasks = readJson(tasksFile, []);
  const data = JSON.stringify(tasks);
  if (!wss) return;
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(data);
    }
  });
}

// GraphQL schema
const schema = buildSchema(`
  type Attachment { filename: String, originalname: String }
  type Task { id: ID!, title: String!, status: String!, dueDate: String, attachments: [Attachment] }
  type User { userId: ID!, email: String! }
  type LoginPayload { token: String }
  type DeletePayload { message: String }
  type LogoutPayload { ok: Boolean }
  input FileInput { data: String!, originalname: String }
  input CreateTaskInput { title: String!, status: String, dueDate: String, file: FileInput }
  input UpdateTaskInput { id: ID!, title: String, status: String, dueDate: String, file: FileInput }

  type Query {
    me: User
    tasks: [Task]
  }

  type Mutation {
    register(email:String!, password:String!): LoginPayload
    login(email:String!, password:String!): LoginPayload
    logout: LogoutPayload
    createTask(input: CreateTaskInput!): Task
    updateTask(input: UpdateTaskInput!): Task
    deleteTask(id: ID!): DeletePayload
  }
`);

const root = {
  me: (args, context) => {
    if (!context.user) throw new Error('Unauthorized');
    return { userId: context.user.userId, email: context.user.email };
  },
  tasks: (args, context) => {
    if (!context.user) throw new Error('Unauthorized');
    tasks = readJson(tasksFile, []);
    return tasks;
  },
  register: async ({ email, password }) => {
    if (!email || !password) throw new Error('Email and password required');
    users = readJson(usersFile, []);
    if (users.find(u => u.email === email)) throw new Error('User exists');
    const id = Date.now();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id, email, passwordHash };
    users.push(user);
    writeJson(usersFile, users);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    return { token };
  },
  login: async ({ email, password }) => {
    users = readJson(usersFile, []);
    const user = users.find(u => u.email === email);
    if (!user) throw new Error('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    return { token };
  },
  logout: () => {
    return { ok: true };
  },
  createTask: ({ input }, context) => {
    if (!context.user) throw new Error('Unauthorized');
    const { title, status = 'pending', dueDate = null, file } = input || {};
    if (!title) throw new Error('title required');
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
    return task;
  },
  updateTask: ({ input }, context) => {
    if (!context.user) throw new Error('Unauthorized');
    const { id, title, status, dueDate, file } = input || {};
    tasks = readJson(tasksFile, []);
    const idx = tasks.findIndex(t => String(t.id) === String(id));
    if (idx === -1) throw new Error('not found');
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
    return tasks[idx];
  },
  deleteTask: ({ id }, context) => {
    if (!context.user) throw new Error('Unauthorized');
    tasks = readJson(tasksFile, []);
    const idx = tasks.findIndex(t => String(t.id) === String(id));
    if (idx === -1) throw new Error('not found');
    tasks.splice(idx, 1);
    writeJson(tasksFile, tasks);
    broadcastTasks();
    return { message: 'deleted' };
  }
};

// GraphQL endpoint with context (auth from cookie)
app.use('/graphql', (req, res, next) => {
  const token = tokenFromCookie(req);
  const user = token ? verifyToken(token) : null;
  req.context = { user };
  next();
}, graphqlHTTP((req) => ({
  schema: schema,
  rootValue: root,
  graphiql: false,
  context: req.context,
  customFormatErrorFn: (err) => ({ message: err.message })
})));


// download attachment via HTTP (protected)
app.get('/api/tasks/:id/files/:filename', (req, res) => {
  const token = tokenFromCookie(req);
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { filename } = req.params;
  const p = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
  res.download(p);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// start server and ws
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
  // start WS after HTTP server is listening
  wss = new WebSocket.Server({ server, path: '/updates' });
  wss.on('connection', (socket) => {
    // on new connection send current tasks
    tasks = readJson(tasksFile, []);
    socket.send(JSON.stringify(tasks));
  });
});