import { axialToWorld, frontierTiles } from './world.js';

const TAU = Math.PI * 2;
const TILT = 0.58;
const CORNERS = Array.from({ length: 6 }, (_, i) => ({ x: Math.cos(i * Math.PI / 3), y: Math.sin(i * Math.PI / 3) }));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function random(seed) {
  let n = seed >>> 0;
  return () => {
    n += 0x6D2B79F5;
    let t = n;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function polygon(ctx, points, fill, stroke, width = 1) {
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

function inside(x, y, points) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** A small, fully local illustrated world. Model coordinates remain independent of the camera. */
export class IslandRenderer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('This browser does not support a 2D canvas.');
    this.callbacks = callbacks;
    this.world = new Map();
    this.tool = 'explore';
    this.terrain = 'meadow';
    this.time = 'day';
    this.motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.center = { x: 0, y: 0 };
    this.hover = null;
    this.decorations = new Map();
    this.listeners = [];
    this.pointers = new Map();
    this.dirty = true;
    this.frame = null;
    this.destroyed = false;
    this.lastFrame = -100;
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  get zoom() { return this._zoom; }

  setWorld(world) {
    this.world = world;
    const positions = Array.from(world.values(), t => axialToWorld(t.q, t.r));
    this.bounds = positions.length ? {
      minX: Math.min(...positions.map(p => p.x)) - 1,
      maxX: Math.max(...positions.map(p => p.x)) + 1,
      minY: Math.min(...positions.map(p => p.y)) - 0.87,
      maxY: Math.max(...positions.map(p => p.y)) + 0.87,
    } : { minX: -2, maxX: 2, minY: -2, maxY: 2 };
    this.frontier = frontierTiles(world);
    for (const [key, cached] of this.decorations) {
      if (!world.has(key) || world.get(key).terrain !== cached.terrain) this.decorations.delete(key);
    }
    for (const [key, tile] of world) {
      if (!this.decorations.has(key)) this.decorations.set(key, this.makeDecorations(tile));
    }
    if (!this.hasWorld) {
      this.hasWorld = true;
      this.fitCamera();
    }
    this.invalidate();
  }

  setTool(tool) {
    this.tool = tool;
    this.hover = null;
    this.canvas.style.cursor = tool === 'explore' ? 'grab' : 'crosshair';
    this.callbacks.onHover?.(null);
    this.invalidate();
  }
  setTerrain(terrain) { this.terrain = terrain; this.invalidate(); }
  setTime(time) { this.time = time; this.invalidate(); }
  setMotion(enabled) { this.motion = enabled; this.invalidate(); }

  panBy(dx, dy) {
    this.pan.x += dx;
    this.pan.y += dy;
    this.invalidate();
  }

  zoomBy(factor, anchor) {
    const oldZoom = this._zoom;
    this._zoom = clamp(this._zoom * factor, 0.48, 2.4);
    const point = anchor || this.origin();
    const origin = this.origin();
    this.pan.x += (point.x - origin.x) * (1 - this._zoom / oldZoom);
    this.pan.y += (point.y - origin.y) * (1 - this._zoom / oldZoom);
    this.callbacks.onViewChange?.({ zoom: this._zoom });
    this.invalidate();
  }

  resetView() {
    this.pan = { x: 0, y: 0 };
    this._zoom = 1;
    this.fitCamera();
    this.callbacks.onViewChange?.({ zoom: this._zoom });
    this.invalidate();
  }

  fitCamera() {
    const b = this.bounds;
    if (!b) return;
    this.center.x = (b.minX + b.maxX) / 2;
    this.center.y = (b.minY + b.maxY) / 2;
    const availableWidth = this.width > 900 ? this.width - 380 : this.width - 56;
    const availableHeight = Math.max(180, this.height - (this.width > 700 ? 220 : 260));
    this.baseSize = Math.min(85, availableWidth / (b.maxX - b.minX + 1), availableHeight / ((b.maxY - b.minY) * TILT + 2.2));
    this.baseSize = Math.max(19, this.baseSize);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.fitCamera();
    this.invalidate();
  }

  origin() {
    return {
      x: this.width * (this.width > 900 ? 0.59 : 0.5) + this.pan.x,
      y: this.height * (this.width > 700 ? 0.54 : 0.47) + this.pan.y,
    };
  }

  project(x, y, z = 0) {
    const origin = this.origin();
    const s = (this.baseSize || 65) * this._zoom;
    return { x: origin.x + (x - this.center.x) * s, y: origin.y + (y - this.center.y) * s * TILT - z * s };
  }

  tilePoints(tile, scale = 1) {
    const c = axialToWorld(tile.q, tile.r);
    return CORNERS.map(p => this.project(c.x + p.x * scale, c.y + p.y * scale));
  }

  bindEvents() {
    const listen = (element, type, handler, options) => {
      element.addEventListener(type, handler, options);
      this.listeners.push(() => element.removeEventListener(type, handler, options));
    };
    const localPoint = event => {
      const r = this.canvas.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };
    listen(this.canvas, 'pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      this.canvas.setPointerCapture(event.pointerId);
      const point = localPoint(event);
      this.pointers.set(event.pointerId, point);
      if (this.pointers.size === 1) {
        this.drag = { start: point, previous: point, moved: false };
      } else {
        this.drag.moved = true;
        this.pinchDistance = this.pointerDistance();
      }
      this.canvas.style.cursor = 'grabbing';
    });
    listen(this.canvas, 'pointermove', event => {
      const point = localPoint(event);
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, point);
        if (this.pointers.size > 1) {
          const distance = this.pointerDistance();
          if (this.pinchDistance > 0) this.zoomBy(distance / this.pinchDistance, this.pointerMidpoint());
          this.pinchDistance = distance;
        } else if (this.drag) {
          const dx = point.x - this.drag.previous.x, dy = point.y - this.drag.previous.y;
          if (Math.hypot(point.x - this.drag.start.x, point.y - this.drag.start.y) > 5) this.drag.moved = true;
          if (this.drag.moved) { this.pan.x += dx; this.pan.y += dy; this.invalidate(); }
          this.drag.previous = point;
        }
        return;
      }
      const hit = this.pick(point);
      if (hit?.key !== this.hover?.key) {
        this.hover = hit;
        this.callbacks.onHover?.(hit?.tile || null);
        this.invalidate();
      }
      this.canvas.style.cursor = hit ? (this.tool === 'explore' ? 'pointer' : 'crosshair') : 'grab';
    });
    const finishPointer = (event, cancelled = false) => {
      if (!this.pointers.has(event.pointerId)) return;
      const point = localPoint(event);
      const wasClick = this.drag && !this.drag.moved && this.pointers.size === 1 && !cancelled;
      this.pointers.delete(event.pointerId);
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (wasClick) {
        const hit = this.pick(point);
        if (hit?.frontier) this.callbacks.onFrontierClick?.(hit.tile);
        else if (hit) this.callbacks.onTileClick?.(hit.tile);
      }
      if (!this.pointers.size) { this.drag = null; this.pinchDistance = 0; }
      else if (this.drag) this.drag.previous = [...this.pointers.values()][0];
      this.canvas.style.cursor = this.tool === 'explore' ? 'grab' : 'crosshair';
    };
    listen(this.canvas, 'pointerup', event => finishPointer(event));
    listen(this.canvas, 'pointercancel', event => finishPointer(event, true));
    listen(this.canvas, 'pointerleave', () => {
      if (!this.pointers.size) { this.hover = null; this.callbacks.onHover?.(null); this.invalidate(); }
    });
    listen(this.canvas, 'wheel', event => {
      event.preventDefault();
      this.zoomBy(Math.exp(-event.deltaY * 0.0013), localPoint(event));
    }, { passive: false });
    listen(document, 'visibilitychange', () => this.invalidate());
  }

  pointerDistance() { const [a, b] = [...this.pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; }
  pointerMidpoint() { const [a, b] = [...this.pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  pick(point) {
    const tiles = [...this.world.values()].sort((a, b) => axialToWorld(b.q, b.r).y - axialToWorld(a.q, a.r).y);
    for (const tile of tiles) if (inside(point.x, point.y, this.tilePoints(tile))) return { key: `${tile.q},${tile.r}`, tile, frontier: false };
    if (this.tool === 'expand') {
      for (const tile of this.frontier || []) if (inside(point.x, point.y, this.tilePoints(tile, 0.91))) return { key: `f:${tile.q},${tile.r}`, tile, frontier: true };
    }
    return null;
  }

  makeDecorations(tile) {
    const rng = random(tile.seed);
    const decorations = [];
    const point = (radius = 0.7) => {
      const a = rng() * TAU, r = Math.sqrt(rng()) * radius;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    };
    const treeCount = tile.terrain === 'grove' ? (rng() > 0.55 ? 3 : 2) : tile.terrain === 'meadow' && rng() > 0.8 ? 1 : 0;
    const treeSites = treeCount === 3 ? [{ x: -0.36, y: -0.23 }, { x: 0.32, y: -0.12 }, { x: -0.05, y: 0.38 }] : treeCount === 2 ? [{ x: -0.29, y: -0.22 }, { x: 0.28, y: 0.29 }] : treeCount === 1 ? [{ x: -0.05, y: -0.06 }] : [];
    treeSites.forEach(p => decorations.push({ type: 'tree', ...p, scale: 0.72 + rng() * 0.33, variant: rng() > 0.7 ? 'pine' : 'round', color: Math.floor(rng() * 4), phase: rng() * TAU }));
    const tufts = tile.terrain === 'earth' ? 3 : 9 + Math.floor(rng() * 6);
    for (let i = 0; i < tufts; i++) decorations.push({ type: 'grass', ...point(0.77), scale: 0.55 + rng() * 0.7, color: rng() });
    const flowers = tile.terrain === 'wildflowers' ? 13 + Math.floor(rng() * 9) : tile.terrain === 'earth' ? 0 : Math.floor(rng() * 4);
    for (let i = 0; i < flowers; i++) decorations.push({ type: 'flower', ...point(0.7), scale: 0.7 + rng() * 0.4, color: Math.floor(rng() * 4), phase: rng() * TAU });
    const rocks = tile.terrain === 'earth' ? 4 : rng() > 0.64 ? 1 : 0;
    for (let i = 0; i < rocks; i++) decorations.push({ type: 'rock', ...point(0.63), scale: 0.15 + rng() * 0.16 });
    return { terrain: tile.terrain, decorations, variant: rng(), phase: rng() * TAU };
  }

  invalidate() {
    this.dirty = true;
    if (!this.frame && !this.destroyed) this.frame = requestAnimationFrame(t => this.tick(t));
  }

  tick(now) {
    this.frame = null;
    if (this.destroyed || document.hidden) return;
    if ((this.dirty || this.motion) && now - this.lastFrame > 30) {
      this.draw(this.motion ? now * 0.001 : 0);
      this.lastFrame = now;
      this.dirty = false;
    }
    if (this.motion || this.dirty) this.frame = requestAnimationFrame(t => this.tick(t));
  }

  draw(time) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawWater(time);
    const tiles = [...this.world.values()].sort((a, b) => axialToWorld(a.q, a.r).y - axialToWorld(b.q, b.r).y);
    if (!tiles.length) return;
    const s = this.baseSize * this._zoom;
    const origin = this.origin();
    ctx.save();
    ctx.filter = `blur(${Math.max(8, s * 0.18)}px)`;
    ellipse(ctx, origin.x + s * 0.13, origin.y + s * 0.72, s * 3.95, s * 1.55, 'rgba(33,105,86,.13)');
    ctx.restore();
    this.drawShoreline(time);
    if (this.tool === 'expand') this.drawFrontier(time);
    for (const tile of tiles) this.drawTile(tile);
    const objects = [];
    for (const tile of tiles) {
      const center = axialToWorld(tile.q, tile.r);
      const data = this.decorations.get(`${tile.q},${tile.r}`);
      for (const item of data?.decorations || []) objects.push({ ...item, x: item.x + center.x, y: item.y + center.y });
    }
    // Shadows sit on the land plane. Objects are painted from back to front.
    for (const obj of objects) if (obj.type === 'tree') this.drawTreeShadow(obj);
    objects.sort((a, b) => a.y - b.y);
    for (const obj of objects) this.drawObject(obj, time);
    if (this.hover && !this.hover.frontier) {
      polygon(ctx, this.tilePoints(this.hover.tile, 0.975), 'rgba(255,255,224,.07)', '#f6ffe0', 2 * this._zoom);
    }
    this.drawButterflies(time);
    this.drawPollen(time);
    if (this.time === 'sunset') {
      ctx.fillStyle = 'rgba(255,173,100,.11)';
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  drawWater(time) {
    const ctx = this.ctx, w = this.width, h = this.height;
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    if (this.time === 'sunset') {
      gradient.addColorStop(0, '#f3e6cc'); gradient.addColorStop(0.48, '#d9e6cd'); gradient.addColorStop(1, '#b5dacf');
    } else {
      gradient.addColorStop(0, '#e9f3e7'); gradient.addColorStop(0.45, '#d0e9dc'); gradient.addColorStop(1, '#afdad0');
    }
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    const light = ctx.createRadialGradient(w * .55, h * .34, 0, w * .55, h * .34, w * .7);
    light.addColorStop(0, 'rgba(250,255,233,.48)'); light.addColorStop(1, 'rgba(250,255,233,0)');
    ctx.fillStyle = light; ctx.fillRect(0, 0, w, h);
    // Long, very soft marks give the water a quiet illustrated texture.
    for (let i = 0; i < 27; i++) {
      const rng = random(i * 7103 + 42);
      const x = rng() * w + Math.sin(time * .12 + i) * 9;
      const y = rng() * h;
      const length = 12 + rng() * 40;
      ctx.strokeStyle = 'rgba(255,255,243,.26)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + length * .5, y + 2, x + length, y); ctx.stroke();
      if (i % 4 === 0) { ctx.beginPath(); ctx.moveTo(x + 8, y + 5); ctx.lineTo(x + length * .7, y + 5); ctx.stroke(); }
    }
    // Airy cloud reflections stay at the perimeter, leaving the island legible.
    ctx.save(); ctx.filter = 'blur(9px)';
    const cloud = (x, y, scale) => {
      ellipse(ctx, x, y, 65 * scale, 11 * scale, 'rgba(255,255,245,.27)');
      ellipse(ctx, x - 25 * scale, y - 5 * scale, 29 * scale, 12 * scale, 'rgba(255,255,245,.28)');
      ellipse(ctx, x + 20 * scale, y - 7 * scale, 38 * scale, 15 * scale, 'rgba(255,255,245,.26)');
    };
    cloud(w * .25 + Math.sin(time * .03) * 20, h * .35, .95);
    cloud(w * .86 - Math.sin(time * .025) * 20, h * .73, 1.25);
    ctx.restore();
  }

  drawShoreline(time) {
    const ctx = this.ctx, s = this.baseSize * this._zoom;
    const neighborDirections = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }];
    // For flat-top hexes each edge faces one of these six axial neighbors.
    for (const tile of this.world.values()) {
      const center = axialToWorld(tile.q, tile.r);
      for (let i = 0; i < 6; i++) {
        const neighbor = neighborDirections[i];
        if (this.world.has(`${tile.q + neighbor.q},${tile.r + neighbor.r}`)) continue;
        const a = CORNERS[i], b = CORNERS[(i + 1) % 6];
        for (let layer = 0; layer < 2; layer++) {
          const expand = 1.09 + layer * .14 + Math.sin(time * .8 + tile.seed % 30) * .015;
          const p1 = this.project(center.x + a.x * expand, center.y + a.y * expand, -.43);
          const p2 = this.project(center.x + b.x * expand, center.y + b.y * expand, -.43);
          ctx.strokeStyle = layer ? 'rgba(248,255,235,.22)' : 'rgba(249,255,239,.48)';
          ctx.lineWidth = (layer ? 1.3 : 2) * this._zoom;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        }
      }
    }
    ctx.lineCap = 'butt';
  }

  drawFrontier(time) {
    const ctx = this.ctx, s = this.baseSize * this._zoom;
    for (const tile of this.frontier || []) {
      const key = `f:${tile.q},${tile.r}`;
      const active = this.hover?.key === key;
      ctx.save();
      ctx.setLineDash([4 * this._zoom, 5 * this._zoom]);
      polygon(ctx, this.tilePoints(tile, .9), active ? 'rgba(255,255,231,.53)' : 'rgba(245,255,230,.15)', active ? '#ffffed' : 'rgba(78,139,104,.43)', 1.1 * this._zoom);
      ctx.restore();
      const center = axialToWorld(tile.q, tile.r), p = this.project(center.x, center.y);
      ellipse(ctx, p.x, p.y, s * .14, s * .14, active ? 'rgba(255,255,243,.92)' : 'rgba(248,255,239,.62)');
      ctx.strokeStyle = '#6d9770'; ctx.lineWidth = 1.5 * this._zoom;
      ctx.beginPath(); ctx.moveTo(p.x - s * .055, p.y); ctx.lineTo(p.x + s * .055, p.y); ctx.moveTo(p.x, p.y - s * .055); ctx.lineTo(p.x, p.y + s * .055); ctx.stroke();
    }
  }

  drawTile(tile) {
    const ctx = this.ctx, s = this.baseSize * this._zoom;
    const points = this.tilePoints(tile);
    const data = this.decorations.get(`${tile.q},${tile.r}`);
    const variation = data?.variant || 0;
    const depth = s * .43;
    const colors = ['#bf8b55', '#aa7547', '#91643e'];
    const sideDirections = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }];
    for (let edge = 0; edge < 3; edge++) {
      const a = points[edge], b = points[edge + 1];
      const n = sideDirections[edge];
      if (this.world.has(`${tile.q + n.q},${tile.r + n.r}`)) continue;
      polygon(ctx, [a, b, { x: b.x, y: b.y + depth }, { x: a.x, y: a.y + depth }], colors[edge], 'rgba(124,83,46,.12)', .7);
      // Little horizontal strata in the warm cut earth.
      const rng = random(tile.seed + edge * 3201);
      ctx.save();
      polygon(ctx, [a, b, { x: b.x, y: b.y + depth }, { x: a.x, y: a.y + depth }]); ctx.clip();
      for (let layer = 0; layer < 3; layer++) {
        const offset = depth * (.38 + layer * .22);
        ctx.beginPath(); ctx.moveTo(a.x, a.y + offset); ctx.lineTo(b.x, b.y + offset + Math.sin(edge) * s * .018);
        ctx.strokeStyle = layer === 1 ? 'rgba(234,183,116,.3)' : 'rgba(105,66,37,.16)';
        ctx.lineWidth = s * (.025 + layer * .006); ctx.stroke();
      }
      for (let i = 0; i < 7; i++) {
        const t = .1 + rng() * .8;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t + depth * (.29 + rng() * .55);
        ellipse(ctx, x, y, s * (.018 + rng() * .018), s * .018, i % 2 ? 'rgba(246,205,145,.5)' : 'rgba(100,63,35,.19)');
      }
      ctx.restore();
      // The grass is a thick, slightly uneven lip over each exposed cliff.
      const grassEdge = tile.terrain === 'earth' ? '#c3a267' : edge === 0 ? '#8cb961' : edge === 1 ? '#78a656' : '#709a4d';
      polygon(ctx, [a, b, { x: b.x, y: b.y + s * .065 }, { x: a.x, y: a.y + s * .065 }], grassEdge);
      for (let i = 0; i < 6; i++) {
        const t = .1 + rng() * .8, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        polygon(ctx, [{ x: x - s * .025, y: y + s * .03 }, { x, y: y + s * (.085 + rng() * .06) }, { x: x + s * .03, y: y + s * .04 }], grassEdge);
      }
    }
    const surface = ctx.createLinearGradient(points[4].x, points[4].y, points[1].x, points[1].y);
    if (tile.terrain === 'earth') {
      surface.addColorStop(0, '#d2bc87'); surface.addColorStop(1, '#c1a26b');
    } else if (tile.terrain === 'grove') {
      surface.addColorStop(0, variation > .5 ? '#a7c979' : '#a1c573'); surface.addColorStop(1, '#88b663');
    } else if (tile.terrain === 'wildflowers') {
      surface.addColorStop(0, '#c5d98a'); surface.addColorStop(1, '#a7ca75');
    } else {
      surface.addColorStop(0, variation > .5 ? '#c0d886' : '#bad382'); surface.addColorStop(1, variation > .5 ? '#a7c975' : '#a2c46e');
    }
    polygon(ctx, points, surface, 'rgba(103,144,73,.27)', .8 * this._zoom);
    // An upper-left sunlight edge keeps all six-sided pieces readable.
    ctx.beginPath(); ctx.moveTo(points[3].x, points[3].y); ctx.lineTo(points[4].x, points[4].y); ctx.lineTo(points[5].x, points[5].y); ctx.lineTo(points[0].x, points[0].y);
    ctx.strokeStyle = tile.terrain === 'earth' ? 'rgba(247,226,180,.6)' : 'rgba(230,244,169,.65)'; ctx.lineWidth = 1.4 * this._zoom; ctx.stroke();
    const center = axialToWorld(tile.q, tile.r);
    const rng = random(tile.seed + 428);
    // Shallow patches stay beneath plants and make every tile feel handmade.
    for (let i = 0; i < 3; i++) {
      const a = rng() * TAU, radius = rng() * .55;
      const p = this.project(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius);
      ellipse(ctx, p.x, p.y, s * (.08 + rng() * .13), s * (.03 + rng() * .035), tile.terrain === 'earth' ? 'rgba(159,124,74,.12)' : 'rgba(225,237,157,.14)');
    }
  }

  drawTreeShadow(obj) {
    const ctx = this.ctx, s = this.baseSize * this._zoom * obj.scale;
    const p = this.project(obj.x, obj.y);
    ctx.save(); ctx.translate(p.x + s * .15, p.y + s * .045); ctx.rotate(.18);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * .4);
    g.addColorStop(0, 'rgba(62,105,49,.23)'); g.addColorStop(.6, 'rgba(62,105,49,.13)'); g.addColorStop(1, 'rgba(62,105,49,0)');
    ctx.scale(1, .43); ellipse(ctx, 0, 0, s * .47, s * .4, g); ctx.restore();
  }

  drawObject(obj, time) {
    const ctx = this.ctx, p = this.project(obj.x, obj.y), s = this.baseSize * this._zoom;
    ctx.save(); ctx.translate(p.x, p.y);
    if (obj.type === 'tree') {
      const sway = Math.sin(time * 1.25 + obj.phase) * .012;
      ctx.scale(s * obj.scale, s * obj.scale);
      this.drawTree(ctx, obj, sway);
    } else if (obj.type === 'grass') {
      ctx.scale(s * obj.scale, s * obj.scale);
      ctx.strokeStyle = obj.color > .5 ? '#80a758' : '#729d50'; ctx.lineWidth = .013; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-.045, 0); ctx.quadraticCurveTo(-.05, -.035, -.075, -.055); ctx.moveTo(0, .005); ctx.quadraticCurveTo(.015, -.045, .002, -.09); ctx.moveTo(.035, .005); ctx.quadraticCurveTo(.05, -.035, .078, -.045); ctx.stroke();
      ctx.strokeStyle = 'rgba(222,237,161,.6)'; ctx.lineWidth = .009; ctx.beginPath(); ctx.moveTo(.015, -.005); ctx.lineTo(.025, -.055); ctx.stroke();
    } else if (obj.type === 'flower') {
      ctx.scale(s * obj.scale, s * obj.scale);
      const sway = Math.sin(time * 1.8 + obj.phase) * .012;
      ctx.strokeStyle = '#7d9e55'; ctx.lineWidth = .012; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, .005); ctx.quadraticCurveTo(sway, -.04, sway, -.105); ctx.stroke();
      ellipse(ctx, -.022, -.035, .024, .009, '#82a75b');
      const color = ['#fff5ce', '#f8da73', '#efb5b1', '#c2b5dc'][obj.color];
      for (let i = 0; i < 5; i++) {
        const a = i * TAU / 5;
        ellipse(ctx, sway + Math.cos(a) * .023, -.108 + Math.sin(a) * .023, .023, .018, color);
      }
      ellipse(ctx, sway, -.108, .014, .014, obj.color === 1 ? '#b68c42' : '#e2b54b');
    } else if (obj.type === 'rock') {
      ctx.scale(s * obj.scale, s * obj.scale);
      ellipse(ctx, .06, .03, .42, .12, 'rgba(80,99,64,.15)');
      polygon(ctx, [{ x: -.4, y: -.05 }, { x: -.29, y: -.35 }, { x: -.05, y: -.49 }, { x: .27, y: -.37 }, { x: .4, y: -.09 }, { x: .24, y: .05 }, { x: -.2, y: .05 }], '#a4afa0');
      polygon(ctx, [{ x: -.29, y: -.35 }, { x: -.05, y: -.49 }, { x: .27, y: -.37 }, { x: .07, y: -.19 }, { x: -.26, y: -.16 }], '#c5cbb5');
      polygon(ctx, [{ x: .07, y: -.19 }, { x: .27, y: -.37 }, { x: .4, y: -.09 }, { x: .24, y: .05 }], '#8a9b8c');
    }
    ctx.restore();
  }

  drawTree(ctx, obj, sway) {
    // Broad trunks and jewel-like leaf facets: a little wooden toy forest.
    polygon(ctx, [{ x: -.055, y: .01 }, { x: -.04, y: -.54 }, { x: .035, y: -.57 }, { x: .065, y: .01 }], '#8a6542');
    polygon(ctx, [{ x: -.055, y: .01 }, { x: -.04, y: -.54 }, { x: -.008, y: -.52 }, { x: -.004, y: .01 }], '#b08854');
    ctx.strokeStyle = '#96704a'; ctx.lineWidth = .035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -.31); ctx.lineTo(-.16, -.5); ctx.moveTo(.01, -.39); ctx.lineTo(.17, -.57); ctx.stroke();
    ctx.save(); ctx.translate(0, -.3); ctx.rotate(sway); ctx.translate(0, .3);
    if (obj.variant === 'pine') {
      const layers = [{ y: -.39, w: .37, h: .4 }, { y: -.62, w: .31, h: .4 }, { y: -.85, w: .23, h: .37 }];
      for (const layer of layers) {
        polygon(ctx, [{ x: 0, y: layer.y - layer.h }, { x: -layer.w, y: layer.y }, { x: -.13, y: layer.y + .065 }, { x: .15, y: layer.y + .055 }, { x: layer.w, y: layer.y }], '#568e5a');
        polygon(ctx, [{ x: 0, y: layer.y - layer.h }, { x: -layer.w, y: layer.y }, { x: -.13, y: layer.y + .065 }, { x: .01, y: layer.y - .04 }], '#81af67');
        polygon(ctx, [{ x: 0, y: layer.y - layer.h }, { x: .01, y: layer.y - .04 }, { x: .15, y: layer.y + .055 }, { x: layer.w, y: layer.y }], '#417f54');
      }
    } else {
      const palettes = [
        ['#75aa59', '#9bc674', '#c0d88b', '#87b565', '#60954e'],
        ['#6b9f52', '#92be66', '#b1d07e', '#7dae5c', '#568c49'],
        ['#7ba85a', '#a4c678', '#c3d88e', '#8db467', '#64924f'],
        ['#649d62', '#88b874', '#add08c', '#77aa66', '#4e8b59'],
      ];
      const c = palettes[obj.color];
      const outline = [{ x: -.34, y: -.49 }, { x: -.46, y: -.7 }, { x: -.4, y: -.91 }, { x: -.24, y: -1.08 }, { x: -.02, y: -1.16 }, { x: .24, y: -1.08 }, { x: .4, y: -.91 }, { x: .43, y: -.68 }, { x: .31, y: -.48 }, { x: .07, y: -.4 }, { x: -.16, y: -.42 }];
      polygon(ctx, outline, c[0]);
      polygon(ctx, [{ x: -.4, y: -.91 }, { x: -.24, y: -1.08 }, { x: -.02, y: -1.16 }, { x: .04, y: -.92 }, { x: -.16, y: -.78 }, { x: -.46, y: -.7 }], c[1]);
      polygon(ctx, [{ x: -.24, y: -1.08 }, { x: -.02, y: -1.16 }, { x: .24, y: -1.08 }, { x: .19, y: -.88 }, { x: .04, y: -.92 }], c[2]);
      polygon(ctx, [{ x: .24, y: -1.08 }, { x: .4, y: -.91 }, { x: .43, y: -.68 }, { x: .18, y: -.67 }, { x: .19, y: -.88 }], c[3]);
      polygon(ctx, [{ x: -.46, y: -.7 }, { x: -.16, y: -.78 }, { x: -.04, y: -.56 }, { x: -.16, y: -.42 }, { x: -.34, y: -.49 }], c[3]);
      polygon(ctx, [{ x: -.04, y: -.56 }, { x: .18, y: -.67 }, { x: .43, y: -.68 }, { x: .31, y: -.48 }, { x: .07, y: -.4 }, { x: -.16, y: -.42 }], c[4]);
      polygon(ctx, [{ x: -.16, y: -.78 }, { x: .04, y: -.92 }, { x: .19, y: -.88 }, { x: .18, y: -.67 }, { x: -.04, y: -.56 }], c[0]);
      // Three tiny lit leaves soften the faceted silhouette.
      ellipse(ctx, -.23, -.95, .035, .018, 'rgba(225,239,172,.42)');
      ellipse(ctx, -.14, -1.01, .025, .014, 'rgba(225,239,172,.4)');
      ellipse(ctx, .1, -1.04, .025, .014, 'rgba(225,239,172,.35)');
    }
    ctx.restore();
  }

  drawButterflies(time) {
    const tiles = [...this.world.values()].filter(t => t.terrain === 'wildflowers');
    const ctx = this.ctx, s = this.baseSize * this._zoom;
    for (let i = 0; i < Math.min(3, tiles.length); i++) {
      const tile = tiles[i], center = axialToWorld(tile.q, tile.r);
      const phase = i * 2.3, orbit = time * .5 + phase;
      const p = this.project(center.x + Math.cos(orbit) * .48, center.y + Math.sin(orbit) * .33, .33 + Math.sin(time * 1.8 + phase) * .08);
      const flutter = .28 + Math.abs(Math.sin(time * 8 + phase)) * .72;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.sin(orbit) * .3);
      ellipse(ctx, -s * .022 * flutter, -s * .007, s * .031 * flutter, s * .024, i % 2 ? '#fff0b3' : '#f1c0b6');
      ellipse(ctx, s * .022 * flutter, -s * .007, s * .031 * flutter, s * .024, i % 2 ? '#ffe49a' : '#f7d0bd');
      ctx.strokeStyle = '#8b805b'; ctx.lineWidth = Math.max(.7, s * .009); ctx.beginPath(); ctx.moveTo(0, -s * .015); ctx.lineTo(0, s * .02); ctx.stroke();
      ctx.restore();
    }
  }

  drawPollen(time) {
    const ctx = this.ctx, origin = this.origin(), s = this.baseSize * this._zoom;
    for (let i = 0; i < 14; i++) {
      const rng = random(i * 12301 + 611);
      const x = origin.x + (rng() - .5) * s * 9 + Math.sin(time * .3 + i) * 12;
      const y = origin.y + (rng() - .5) * s * 5 - ((time * 5 + i * 13) % 45);
      const opacity = .18 + (Math.sin(time * .6 + i) + 1) * .14;
      ellipse(ctx, x, y, 1.2 * this._zoom, 1.2 * this._zoom, `rgba(255,255,219,${opacity})`);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.listeners.forEach(dispose => dispose());
    this.listeners = [];
    this.pointers.clear();
  }
}
