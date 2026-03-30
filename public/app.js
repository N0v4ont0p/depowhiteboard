'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   WhiteBoard  ·  app.js
   Real-time collaborative drawing engine + Socket.io client
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Preset color palette ───────────────────────────────────────────────────
const PRESET_COLORS = [
  '#000000','#ffffff','#434343','#9b9b9b',
  '#e03131','#f76707','#f59f00','#2f9e44',
  '#0c8599','#1971c2','#6741d9','#a61e4d',
  '#ff6b6b','#ffa94d','#ffe066','#69db7c',
  '#38d9a9','#4dabf7','#da77f2','#f783ac',
];

// ─── Tool keyboard shortcuts ────────────────────────────────────────────────
const TOOL_KEYS = {
  p:'pen', b:'brush', m:'marker', h:'highlighter', e:'eraser',
  l:'line', a:'arrow', r:'rect',  c:'circle',
  t:'text', f:'fill',
};

// ─── Cursor styles per tool ──────────────────────────────────────────────────
const TOOL_CURSORS = {
  pen:'crosshair', brush:'crosshair', marker:'crosshair',
  highlighter:'crosshair', eraser:'cell',
  line:'crosshair', arrow:'crosshair', rect:'crosshair', circle:'crosshair',
  text:'text', fill:'copy',
};

/* ═══════════════════════════════════════════════════════════════════════════
   WhiteboardApp
   ═══════════════════════════════════════════════════════════════════════════ */
class WhiteboardApp {
  constructor() {
    // ── Canvas ──────────────────────────────────────────────────────────
    this.canvas        = document.getElementById('canvas');
    this.ctx           = this.canvas.getContext('2d');
    // Offscreen canvas stores all committed strokes (avoids full re-render every frame)
    this.committed     = document.createElement('canvas');
    this.committedCtx  = this.committed.getContext('2d');

    // ── Tool state ───────────────────────────────────────────────────────
    this.tool       = 'pen';
    this.color      = '#000000';
    this.brushSize  = 5;
    this.opacity    = 1.0;
    this.fillShapes = false;

    // ── Drawing state ─────────────────────────────────────────────────
    this.isDrawing  = false;
    this.points     = [];      // points collected in current stroke
    this.startPt    = null;    // first point (used for shapes)
    this.strokeId   = null;

    // ── History ──────────────────────────────────────────────────────
    this.strokes    = [];      // all committed strokes (local mirror of server state)
    this.myStrokes  = [];      // strokes committed by THIS user (for undo)
    this.redoStack  = [];      // for redo

    // ── Remote state ─────────────────────────────────────────────────
    this.userId       = null;
    this.userColor    = '#89b4fa';
    this.remoteLive   = new Map();   // userId → { stroke, points[] }
    this.remoteCursors= new Map();   // userId → { el, color, name }

    // ── Throttle timers ──────────────────────────────────────────────
    this._lastPointEmit  = 0;
    this._lastCursorEmit = 0;

    // ── Active text input ────────────────────────────────────────────
    this.textInput = null;

    // ── Room ─────────────────────────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    this.roomId = params.get('room') || 'default';

    this.socket = null;
    this.init();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════════
  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.setupSocket();
    this.setupCanvas();
    this.setupUI();
    this.setupKeyboard();
    this.startRenderLoop();

    document.getElementById('room-id-display').textContent = this.roomId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Canvas resize — resize both canvases and redraw
  // ═══════════════════════════════════════════════════════════════════════
  resize() {
    const container = document.getElementById('canvas-container');
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;

    // Preserve committed content
    const tmp = document.createElement('canvas');
    tmp.width  = this.committed.width  || w;
    tmp.height = this.committed.height || h;
    tmp.getContext('2d').drawImage(this.committed, 0, 0);

    this.canvas.width    = w;
    this.canvas.height   = h;
    this.committed.width  = w;
    this.committed.height = h;

    // White background
    this.committedCtx.fillStyle = '#ffffff';
    this.committedCtx.fillRect(0, 0, w, h);
    // Restore previous content
    this.committedCtx.drawImage(tmp, 0, 0);
  }

  // Full redraw of all strokes onto committed canvas (used after undo/clear)
  redrawAll() {
    const ctx = this.committedCtx;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.committed.width, this.committed.height);
    for (const stroke of this.strokes) {
      this.renderStroke(ctx, stroke);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Socket.io
  // ═══════════════════════════════════════════════════════════════════════
  setupSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      this.socket.emit('join-room', { room: this.roomId });
    });

    this.socket.on('init-board', (data) => {
      this.userId    = data.userId;
      this.userColor = data.userColor;

      // Set own user dot color
      const myDot = document.getElementById('my-dot');
      if (myDot) myDot.style.background = data.userColor;

      // Populate remote avatars (all currently connected users)
      if (data.users) {
        data.users.forEach(u => {
          if (u.id !== this.userId) this.addRemoteCursor(u.id, u.color, u.name);
        });
      }

      // Replay board history
      this.strokes = data.strokes || [];
      this.redrawAll();

      this.updateUserCount(data.users ? data.users.length : 1);
      this.hideLoading();
      this.showToast('Connected — share the link to collaborate 🎉', 'success');
    });

    this.socket.on('user-joined', ({ userId, user }) => {
      this.addRemoteCursor(userId, user.color, user.name);
      this.showToast(`${user.name} joined`, 'info');
    });

    this.socket.on('user-left', ({ userId }) => {
      this.removeRemoteCursor(userId);
      this.remoteLive.delete(userId);
    });

    this.socket.on('user-count', (n) => this.updateUserCount(n));

    // Remote live drawing
    this.socket.on('remote-stroke-start', ({ userId, stroke, startPt }) => {
      this.remoteLive.set(userId, { stroke, points: startPt ? [startPt] : [] });
    });

    this.socket.on('remote-stroke-point', ({ userId, point }) => {
      const live = this.remoteLive.get(userId);
      if (live) live.points.push(point);
    });

    this.socket.on('remote-stroke-end', ({ stroke }) => {
      // Remove live preview, commit to canvas
      this.remoteLive.delete(stroke.userId);
      this.strokes.push(stroke);
      this.renderStroke(this.committedCtx, stroke);
    });

    this.socket.on('board-update', ({ strokes }) => {
      this.strokes = strokes;
      this.redrawAll();
    });

    this.socket.on('board-cleared', () => {
      this.strokes    = [];
      this.myStrokes  = [];
      this.redoStack  = [];
      this.committedCtx.fillStyle = '#ffffff';
      this.committedCtx.fillRect(0, 0, this.committed.width, this.committed.height);
    });

    this.socket.on('remote-cursor', ({ userId, x, y }) => {
      this.moveRemoteCursor(userId, x, y);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Canvas event handlers
  // ═══════════════════════════════════════════════════════════════════════
  setupCanvas() {
    const cv = this.canvas;

    // Set initial cursor based on default tool
    cv.style.cursor = TOOL_CURSORS[this.tool] || 'crosshair';

    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return { x: src.clientX - r.left, y: src.clientY - r.top };
    };

    cv.addEventListener('mousedown',  (e) => { const p = pos(e); this.startStroke(p.x, p.y); });
    cv.addEventListener('mousemove',  (e) => { const p = pos(e); this.continueStroke(p.x, p.y); this.emitCursor(p.x, p.y); });
    cv.addEventListener('mouseup',    (e) => { const p = pos(e); this.endStroke(p.x, p.y); });
    cv.addEventListener('mouseleave', (e) => { if (this.isDrawing) { const p = pos(e); this.endStroke(p.x, p.y); }});

    cv.addEventListener('touchstart',  (e) => { e.preventDefault(); const p = pos(e); this.startStroke(p.x, p.y); },    { passive: false });
    cv.addEventListener('touchmove',   (e) => { e.preventDefault(); const p = pos(e); this.continueStroke(p.x, p.y); this.emitCursor(p.x, p.y); }, { passive: false });
    cv.addEventListener('touchend',    (e) => { e.preventDefault(); this.endStroke(); }, { passive: false });
    cv.addEventListener('touchcancel', (e) => { e.preventDefault(); this.endStroke(); }, { passive: false });
  }

  emitCursor(x, y) {
    const now = Date.now();
    if (now - this._lastCursorEmit > 40) {
      this._lastCursorEmit = now;
      this.socket.emit('cursor-move', { x, y });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Drawing lifecycle
  // ═══════════════════════════════════════════════════════════════════════
  startStroke(x, y) {
    // Text tool — place input overlay
    if (this.tool === 'text') {
      this.handleTextTool(x, y);
      return;
    }
    // Fill tool — immediate flood fill
    if (this.tool === 'fill') {
      this.performFill(x, y);
      return;
    }

    this.isDrawing = true;
    this.points    = [{ x, y }];
    this.startPt   = { x, y };
    this.strokeId  = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

    const strokeMeta = {
      id:      this.strokeId,
      tool:    this.tool,
      color:   this.tool === 'eraser' ? '#ffffff' : this.color,
      size:    this.brushSize,
      opacity: this.opacity,
      filled:  this.fillShapes,
    };

    this.socket.emit('stroke-start', { stroke: strokeMeta, startPt: { x, y } });
  }

  continueStroke(x, y) {
    if (!this.isDrawing) return;
    this.points.push({ x, y });

    const now = Date.now();
    if (now - this._lastPointEmit > 16) {   // cap at ~60fps
      this._lastPointEmit = now;
      this.socket.emit('stroke-point', { strokeId: this.strokeId, point: { x, y } });
    }
  }

  endStroke(x, y) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (x !== undefined && y !== undefined) this.points.push({ x, y });

    const isFree = ['pen','brush','marker','eraser','highlighter'].includes(this.tool);
    const pts    = isFree
      ? this.points
      : (this.points.length >= 2
          ? [this.startPt, this.points[this.points.length - 1]]
          : [this.startPt, this.startPt]);

    const stroke = {
      id:        this.strokeId,
      userId:    this.userId,
      tool:      this.tool,
      color:     this.tool === 'eraser' ? '#ffffff' : this.color,
      size:      this.brushSize,
      opacity:   this.opacity,
      filled:    this.fillShapes,
      points:    pts,
      timestamp: Date.now(),
    };

    // Optimistic local commit
    this.strokes.push(stroke);
    this.myStrokes.push(stroke);
    this.redoStack = [];   // new stroke clears redo
    this.renderStroke(this.committedCtx, stroke);

    this.socket.emit('stroke-end', { stroke });

    this.points   = [];
    this.startPt  = null;
    this.strokeId = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Stroke rendering
  // ═══════════════════════════════════════════════════════════════════════
  renderStroke(ctx, stroke) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity ?? 1;

    switch (stroke.tool) {
      case 'pen':         this.renderFree(ctx, stroke, stroke.size, 'round', 'round', 1);  break;
      case 'brush':       this.renderFree(ctx, stroke, stroke.size * 2.5, 'round', 'round', 0.75); break;
      case 'marker':      this.renderFree(ctx, stroke, stroke.size * 3, 'square', 'bevel', 1); break;
      case 'eraser':      this.renderFree(ctx, stroke, stroke.size * 2, 'round', 'round', 1); break;
      case 'highlighter': this.renderHighlighter(ctx, stroke); break;
      case 'line':        this.renderLine(ctx, stroke);   break;
      case 'arrow':       this.renderArrow(ctx, stroke);  break;
      case 'rect':        this.renderRect(ctx, stroke);   break;
      case 'circle':      this.renderCircle(ctx, stroke); break;
      case 'text':        this.renderText(ctx, stroke);   break;
      case 'fill':        this.renderFill(ctx, stroke);   break;
    }

    ctx.restore();
  }

  // Smooth freehand path via quadratic Bézier mid-points
  renderFree(ctx, stroke, width, cap, join, alphaScale) {
    const pts = stroke.points;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = width;
    ctx.lineCap     = cap;
    ctx.lineJoin    = join;
    ctx.globalAlpha = (stroke.opacity ?? 1) * alphaScale;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  renderHighlighter(ctx, stroke) {
    const pts = stroke.points;
    ctx.globalAlpha  = 0.28;
    ctx.strokeStyle  = stroke.color;
    ctx.lineWidth    = stroke.size * 6;
    ctx.lineCap      = 'square';
    ctx.lineJoin     = 'bevel';

    if (pts.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.fillRect(pts[0].x - stroke.size * 3, pts[0].y - stroke.size * 3, stroke.size * 6, stroke.size * 6);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  renderLine(ctx, stroke) {
    const [s, e] = stroke.points;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = stroke.size;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
  }

  renderArrow(ctx, stroke) {
    if (stroke.points.length < 2) return;
    const [s, e] = stroke.points;
    const dx   = e.x - s.x;
    const dy   = e.y - s.y;
    const len  = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    ctx.strokeStyle = stroke.color;
    ctx.fillStyle   = stroke.color;
    ctx.lineWidth   = stroke.size;
    ctx.lineCap     = 'round';

    // Shaft
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();

    // Arrowhead
    const headLen = Math.min(16 + stroke.size * 2, len * 0.45);
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x - headLen * Math.cos(angle - Math.PI / 6), e.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(e.x - headLen * Math.cos(angle + Math.PI / 6), e.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  renderRect(ctx, stroke) {
    const [s, e] = stroke.points;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle   = stroke.color;
    ctx.lineWidth   = stroke.size;
    const x = Math.min(s.x, e.x);
    const y = Math.min(s.y, e.y);
    const w = Math.abs(e.x - s.x);
    const h = Math.abs(e.y - s.y);
    if (stroke.filled) ctx.fillRect(x, y, w, h);
    else               ctx.strokeRect(x, y, w, h);
  }

  renderCircle(ctx, stroke) {
    if (stroke.points.length < 2) return;
    const [s, e] = stroke.points;
    const cx = (s.x + e.x) / 2;
    const cy = (s.y + e.y) / 2;
    const rx = Math.abs(e.x - s.x) / 2;
    const ry = Math.abs(e.y - s.y) / 2;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle   = stroke.color;
    ctx.lineWidth   = stroke.size;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, 0, Math.PI * 2);
    if (stroke.filled) ctx.fill();
    else               ctx.stroke();
  }

  renderText(ctx, stroke) {
    if (!stroke.text) return;
    const p = stroke.points[0];
    ctx.fillStyle = stroke.color;
    ctx.font      = `${stroke.size * 4}px 'Inter', sans-serif`;
    ctx.globalAlpha = stroke.opacity ?? 1;
    // Support multi-line text
    const lines = stroke.text.split('\n');
    const lh = stroke.size * 4 * 1.3;
    lines.forEach((line, i) => ctx.fillText(line, p.x, p.y + i * lh));
  }

  renderFill(ctx, stroke) {
    const p = stroke.points[0];
    this.floodFill(ctx, Math.round(p.x), Math.round(p.y), stroke.color);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Flood fill (iterative scanline)
  // ═══════════════════════════════════════════════════════════════════════
  floodFill(ctx, sx, sy, fillHex) {
    const cv   = ctx.canvas;
    const W    = cv.width;
    const H    = cv.height;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;

    const img  = ctx.getImageData(0, 0, W, H);
    const data = img.data;
    const idx  = (x, y) => (y * W + x) * 4;

    const si = idx(sx, sy);
    const tR = data[si], tG = data[si+1], tB = data[si+2], tA = data[si+3];
    const [fR, fG, fB] = this.hexToRgb(fillHex);

    // Already same color
    if (tR === fR && tG === fG && tB === fB && tA === 255) return;

    const match = (i) =>
      data[i]===tR && data[i+1]===tG && data[i+2]===tB && data[i+3]===tA;

    const visited = new Uint8Array(W * H);
    const stack   = [sy * W + sx];

    let iter = 0;
    while (stack.length && iter++ < 2_000_000) {
      const pos = stack.pop();
      if (visited[pos]) continue;
      const x = pos % W;
      const y = (pos / W) | 0;
      const i = pos * 4;
      if (!match(i)) continue;

      visited[pos] = 1;
      data[i]   = fR;
      data[i+1] = fG;
      data[i+2] = fB;
      data[i+3] = 255;

      if (x > 0)     stack.push(pos - 1);
      if (x < W - 1) stack.push(pos + 1);
      if (y > 0)     stack.push(pos - W);
      if (y < H - 1) stack.push(pos + W);
    }
    ctx.putImageData(img, 0, 0);
  }

  hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? [parseInt(r[1],16), parseInt(r[2],16), parseInt(r[3],16)] : [0,0,0];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Text tool
  // ═══════════════════════════════════════════════════════════════════════
  handleTextTool(x, y) {
    if (this.textInput) this.commitText();

    const container = document.getElementById('text-input-container');
    const el = document.createElement('textarea');
    el.className = 'text-input-overlay';
    el.style.left     = `${x}px`;
    el.style.top      = `${y}px`;
    el.style.fontSize = `${this.brushSize * 4}px`;
    el.style.color    = this.color;
    el.rows = 1;
    container.appendChild(el);
    el.focus();

    this.textInput = { el, x, y };

    el.addEventListener('blur', () => {
      // Small delay so clicking elsewhere doesn't race
      setTimeout(() => this.commitText(), 80);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.remove();
        this.textInput = null;
      }
    });
  }

  commitText() {
    if (!this.textInput) return;
    const { el, x, y } = this.textInput;
    const text = el.value.trim();
    this.textInput = null;
    if (el.parentNode) el.parentNode.removeChild(el);

    if (!text) return;

    const stroke = {
      id:        `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`,
      userId:    this.userId,
      tool:      'text',
      color:     this.color,
      size:      this.brushSize,
      opacity:   this.opacity,
      filled:    false,
      points:    [{ x, y: y + this.brushSize * 4 }],
      text,
      timestamp: Date.now(),
    };

    this.strokes.push(stroke);
    this.myStrokes.push(stroke);
    this.redoStack = [];
    this.renderStroke(this.committedCtx, stroke);
    this.socket.emit('stroke-end', { stroke });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Fill tool
  // ═══════════════════════════════════════════════════════════════════════
  performFill(x, y) {
    const stroke = {
      id:        `${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`,
      userId:    this.userId,
      tool:      'fill',
      color:     this.color,
      size:      1,
      opacity:   1,
      filled:    true,
      points:    [{ x: Math.round(x), y: Math.round(y) }],
      timestamp: Date.now(),
    };

    // Apply locally first for instant feedback
    this.floodFill(this.committedCtx, Math.round(x), Math.round(y), this.color);
    this.strokes.push(stroke);
    this.myStrokes.push(stroke);
    this.redoStack = [];
    this.socket.emit('stroke-end', { stroke });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Render loop
  // ═══════════════════════════════════════════════════════════════════════
  startRenderLoop() {
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  render() {
    const ctx = this.ctx;
    const w   = this.canvas.width;
    const h   = this.canvas.height;

    // Layer 0: committed strokes
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.committed, 0, 0);

    // Layer 1: current user's live stroke (preview)
    if (this.isDrawing && this.points.length > 0) {
      const isFree = ['pen','brush','marker','eraser','highlighter'].includes(this.tool);
      const pts = isFree
        ? this.points
        : [this.startPt, this.points[this.points.length - 1]];

      this.renderStroke(ctx, {
        tool:    this.tool,
        color:   this.tool === 'eraser' ? '#ffffff' : this.color,
        size:    this.brushSize,
        opacity: this.opacity,
        filled:  this.fillShapes,
        points:  pts,
      });
    }

    // Layer 2: remote users' live strokes
    for (const [, live] of this.remoteLive) {
      if (!live.points.length) continue;
      const isFree = ['pen','brush','marker','eraser','highlighter'].includes(live.stroke.tool);
      const pts = isFree
        ? live.points
        : [live.points[0], live.points[live.points.length - 1]];
      this.renderStroke(ctx, { ...live.stroke, points: pts });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Undo / Redo
  // ═══════════════════════════════════════════════════════════════════════
  undo() {
    if (this.myStrokes.length === 0) return;
    const stroke = this.myStrokes.pop();
    this.redoStack.push(stroke);
    this.socket.emit('undo', { strokeId: stroke.id });
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const stroke = this.redoStack.pop();
    this.myStrokes.push(stroke);
    // Add to local view immediately
    if (!this.strokes.find(s => s.id === stroke.id)) {
      this.strokes.push(stroke);
      this.renderStroke(this.committedCtx, stroke);
    }
    this.socket.emit('stroke-end', { stroke });
  }

  clearBoard() {
    if (window.confirm('Clear the entire whiteboard for everyone? This cannot be undone.')) {
      this.socket.emit('clear-board');
    }
  }

  download() {
    const a   = document.createElement('a');
    a.download = `whiteboard-${this.roomId}.png`;
    a.href     = this.committed.toDataURL('image/png');
    a.click();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Remote cursors
  // ═══════════════════════════════════════════════════════════════════════
  addRemoteCursor(userId, color, name) {
    if (this.remoteCursors.has(userId)) return;
    const wrapper = document.getElementById('cursors');
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.innerHTML = `
      <svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 2L2 18L6 13.5L9.5 21L12 20L8.5 12.5L15 12.5Z"
              fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div class="cursor-label" style="background:${color}">${this.escHtml(name)}</div>`;
    el.style.left = '-100px';
    el.style.top  = '-100px';
    wrapper.appendChild(el);
    this.remoteCursors.set(userId, { el, color, name });

    // Add avatar dot in header
    const avatarsEl = document.getElementById('user-avatars');
    const dot = document.createElement('div');
    dot.className = 'user-avatar-dot';
    dot.id = `avatar-${userId}`;
    dot.style.background = color;
    dot.title = name;
    dot.textContent = name.slice(-4);
    avatarsEl.appendChild(dot);
  }

  moveRemoteCursor(userId, x, y) {
    const c = this.remoteCursors.get(userId);
    if (c) { c.el.style.left = `${x}px`; c.el.style.top = `${y}px`; }
  }

  removeRemoteCursor(userId) {
    const c = this.remoteCursors.get(userId);
    if (c) { c.el.remove(); this.remoteCursors.delete(userId); }
    const av = document.getElementById(`avatar-${userId}`);
    if (av) av.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI setup
  // ═══════════════════════════════════════════════════════════════════════
  setupUI() {
    // Tool buttons
    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool;
        document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.canvas.style.cursor = TOOL_CURSORS[this.tool] || 'crosshair';
      });
    });

    // Action buttons
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.action;
        if (a === 'undo')     this.undo();
        if (a === 'redo')     this.redo();
        if (a === 'clear')    this.clearBoard();
        if (a === 'download') this.download();
      });
    });

    // Build color palette
    const palette = document.getElementById('color-palette');
    PRESET_COLORS.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.className   = 'color-swatch' + (i === 0 ? ' active' : '');
      sw.style.background = c;
      sw.title = c;
      // Give white swatch a border so it's visible
      if (c === '#ffffff') sw.style.boxShadow = 'inset 0 0 0 1px #ccc';
      sw.addEventListener('click', () => this.selectColor(c, sw));
      palette.appendChild(sw);
    });

    // Native color picker
    const picker = document.getElementById('color-picker');
    // Clicking the color dot opens picker
    document.getElementById('current-color-btn').addEventListener('click', () => picker.click());
    picker.addEventListener('input', (e) => this.selectColor(e.target.value, null));

    // Size slider
    const szSlider = document.getElementById('size-slider');
    const szLabel  = document.getElementById('size-label');
    szSlider.addEventListener('input', () => {
      this.brushSize = +szSlider.value;
      szLabel.textContent = this.brushSize;
      this.updateSizePreview();
    });
    this.updateSizePreview();

    // Opacity slider
    const opSlider = document.getElementById('opacity-slider');
    const opLabel  = document.getElementById('opacity-label');
    opSlider.addEventListener('input', () => {
      this.opacity = opSlider.value / 100;
      opLabel.textContent = opSlider.value + '%';
    });

    // Fill toggle
    document.getElementById('fill-toggle').addEventListener('change', (e) => {
      this.fillShapes = e.target.checked;
    });

    // Share / copy link
    document.getElementById('copy-link-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        this.showToast('Link copied! Share it with friends 🔗', 'success');
      }).catch(() => {
        this.showToast('Copy this URL: ' + window.location.href, 'info');
      });
    });

    // Download
    document.getElementById('download-btn').addEventListener('click', () => this.download());
  }

  selectColor(hex, swatchEl) {
    this.color = hex;
    document.getElementById('current-color-dot').style.background = hex;
    document.getElementById('color-picker').value = hex;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    if (swatchEl) swatchEl.classList.add('active');
    this.updateSizePreview();
  }

  updateSizePreview() {
    const preview = document.getElementById('size-preview');
    const d = Math.min(Math.max(this.brushSize, 3), 36);
    preview.style.width    = `${d}px`;
    preview.style.height   = `${d}px`;
    preview.style.background = this.color;
  }

  updateUserCount(n) {
    document.getElementById('user-count').textContent = n;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Keyboard shortcuts
  // ═══════════════════════════════════════════════════════════════════════
  setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.download(); return; }

      const toolKey = TOOL_KEYS[e.key.toLowerCase()];
      if (toolKey) {
        const btn = document.querySelector(`[data-tool="${toolKey}"]`);
        if (btn) btn.click();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Toast notifications
  // ═══════════════════════════════════════════════════════════════════════
  showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 320);
    }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Loading screen
  // ═══════════════════════════════════════════════════════════════════════
  hideLoading() {
    const ls  = document.getElementById('loading-screen');
    const app = document.getElementById('app');
    app.style.display = 'grid';
    setTimeout(() => {
      ls.classList.add('hidden');
      // Trigger resize now that the app is visible, then redraw
      // strokes on the correctly-sized canvas
      this.resize();
      this.redrawAll();
    }, 300);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════
  escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => { new WhiteboardApp(); });
