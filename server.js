'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Allow all origins for a share-with-friends whiteboard.
// In production you would restrict this to your own domain, e.g.:
//   cors: { origin: 'https://yourdomain.com' }
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*' },
  maxHttpBufferSize: 1e7,   // 10 MB — large enough for stroke payloads
});

app.use(express.static(path.join(__dirname, 'public')));

// Redirect bare "/" to a new room
app.get('/', (req, res) => {
  if (!req.query.room) {
    const roomId = uuidv4().replace(/-/g, '').slice(0, 8);
    return res.redirect(`/?room=${roomId}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── In-memory room storage ────────────────────────────────────────────────
const rooms = new Map();

const USER_COLORS = [
  '#89b4fa', '#cba6f7', '#f38ba8', '#fab387', '#f9e2af',
  '#a6e3a1', '#94e2d5', '#89dceb', '#f5c2e7', '#74c7ec',
];
let colorIdx = 0;

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { strokes: [], users: new Map() });
  }
  return rooms.get(id);
}

// ─── Socket events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let roomId = null;
  const userId = uuidv4().replace(/-/g, '').slice(0, 8);
  const userColor = USER_COLORS[colorIdx++ % USER_COLORS.length];
  const userName = `User ${Math.floor(Math.random() * 9000) + 1000}`;

  // ── join-room ──────────────────────────────────────────────────────────
  socket.on('join-room', ({ room }) => {
    roomId = String(room).slice(0, 32);
    socket.join(roomId);

    const r = getRoom(roomId);
    r.users.set(userId, { name: userName, color: userColor });

    // Send the full board history to the joining user
    socket.emit('init-board', {
      userId,
      userColor,
      userName,
      strokes: r.strokes,
      users: [...r.users.entries()].map(([id, u]) => ({ id, ...u })),
    });

    // Tell everyone else someone joined
    socket.to(roomId).emit('user-joined', {
      userId,
      user: { name: userName, color: userColor },
    });

    io.to(roomId).emit('user-count', r.users.size);
  });

  // ── live drawing: start ────────────────────────────────────────────────
  socket.on('stroke-start', (data) => {
    if (!roomId) return;
    socket.to(roomId).emit('remote-stroke-start', { userId, ...data });
  });

  // ── live drawing: point ────────────────────────────────────────────────
  socket.on('stroke-point', (data) => {
    if (!roomId) return;
    socket.to(roomId).emit('remote-stroke-point', { userId, ...data });
  });

  // ── commit finished stroke ─────────────────────────────────────────────
  socket.on('stroke-end', ({ stroke }) => {
    if (!roomId) return;
    const r = getRoom(roomId);
    // Deduplicate by id
    if (!r.strokes.find((s) => s.id === stroke.id)) {
      r.strokes.push(stroke);
    }
    socket.to(roomId).emit('remote-stroke-end', { userId, stroke });
  });

  // ── undo ───────────────────────────────────────────────────────────────
  socket.on('undo', ({ strokeId }) => {
    if (!roomId) return;
    const r = getRoom(roomId);
    const idx = r.strokes.findIndex(
      (s) => s.id === strokeId && s.userId === userId
    );
    if (idx !== -1) {
      r.strokes.splice(idx, 1);
      io.to(roomId).emit('board-update', { strokes: r.strokes });
    }
  });

  // ── clear board ────────────────────────────────────────────────────────
  socket.on('clear-board', () => {
    if (!roomId) return;
    const r = getRoom(roomId);
    r.strokes = [];
    io.to(roomId).emit('board-cleared');
  });

  // ── cursor position ────────────────────────────────────────────────────
  socket.on('cursor-move', ({ x, y }) => {
    if (!roomId) return;
    socket.to(roomId).emit('remote-cursor', { userId, x, y });
  });

  // ── disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.users.delete(userId);
    io.to(roomId).emit('user-left', { userId });
    io.to(roomId).emit('user-count', r.users.size);

    // Purge empty rooms after 30 minutes
    if (r.users.size === 0) {
      setTimeout(() => {
        const still = rooms.get(roomId);
        if (still && still.users.size === 0) rooms.delete(roomId);
      }, 30 * 60 * 1000);
    }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✦ WhiteBoard server running → http://localhost:${PORT}`);
});
