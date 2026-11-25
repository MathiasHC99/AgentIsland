import { axialToWorld, STATIONS } from './world.js';
import { EYE_HEIGHT } from './player.js';

const TAU = Math.PI * 2;
const NEAR = .045;
const GRASS = { meadow: '#b3ce7e', grove: '#97b96d', wildflowers: '#bfd187', earth: '#c8ac79' };

/** Local perspective renderer: shares the editor's tiles and decoration seeds. */
export class FirstPersonRenderer {
  constructor(renderer) { this.renderer = renderer; }

  cameraPoint(p) {
    const { player } = this.renderer.explorer;
    const dx = p.x - player.x, dy = p.y - player.y, dz = p.z - EYE_HEIGHT - player.z;
    const forward = dx * Math.sin(player.yaw) - dy * Math.cos(player.yaw);
    return {
      x: dx * Math.cos(player.yaw) + dy * Math.sin(player.yaw),
      y: dz * Math.cos(player.pitch) - forward * Math.sin(player.pitch),
      z: forward * Math.cos(player.pitch) + dz * Math.sin(player.pitch),
    };
  }

  screen(p) {
    return { x: this.width / 2 + p.x * this.focal / p.z, y: this.height / 2 - p.y * this.focal / p.z };
  }

  project(x, y, z) {
    const p = this.cameraPoint({ x, y, z });
    return p.z > NEAR ? { ...this.screen(p), depth: p.z } : null;
  }

  face(points, color, queue = this.faces) {
    const camera = points.map(p => this.cameraPoint(p));
    const clipped = [];
    for (let i = 0; i < camera.length; i++) {
      const a = camera[i], b = camera[(i + 1) % camera.length];
      if (a.z >= NEAR) clipped.push(a);
      if ((a.z >= NEAR) !== (b.z >= NEAR)) {
        const t = (NEAR - a.z) / (b.z - a.z);
        clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR });
      }
    }
    if (clipped.length < 3) return;
    const projected = clipped.map(p => this.screen(p));
    if (projected.every(p => p.x < 0) || projected.every(p => p.x > this.width) || projected.every(p => p.y < 0) || projected.every(p => p.y > this.height)) return;
    queue.push({ points: projected, color, depth: camera.reduce((sum, p) => sum + p.z, 0) / camera.length });
  }

  paint(queue) {
    const ctx = this.renderer.ctx;
    queue.sort((a, b) => b.depth - a.depth);
    for (const face of queue) {
      ctx.beginPath();
      face.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = face.color;
      ctx.fill();
      // Matching edges close subpixel cracks between low-poly faces.
      ctx.strokeStyle = face.color; ctx.lineWidth = .5; ctx.stroke();
    }
  }

  box(x, y, z, w, d, h, color, light = color, dark = color) {
    const p = [
      { x: x - w / 2, y: y - d / 2, z }, { x: x + w / 2, y: y - d / 2, z },
      { x: x + w / 2, y: y + d / 2, z }, { x: x - w / 2, y: y + d / 2, z },
    ];
    const top = p.map(p => ({ ...p, z: z + h }));
    this.face(top, light);
    for (let i = 0; i < 4; i++) this.face([p[i], p[(i + 1) % 4], top[(i + 1) % 4], top[i]], i % 2 ? dark : color);
  }

  crown(x, y, bottom, radius, height, color, peakRadius = 0) {
    const shades = [color, '#88b66b', '#7aa65e', '#659557', '#5a8b52', color, '#a5c980', '#a5c980'];
    const ring = Array.from({ length: 8 }, (_, i) => ({ x: x + Math.cos(i * TAU / 8) * radius, y: y + Math.sin(i * TAU / 8) * radius, z: bottom }));
    const top = ring.map((p, i) => ({ x: x + Math.cos(i * TAU / 8) * peakRadius, y: y + Math.sin(i * TAU / 8) * peakRadius, z: bottom + height }));
    for (let i = 0; i < 8; i++) this.face([ring[i], ring[(i + 1) % 8], top[(i + 1) % 8], top[i]], shades[i]);
    if (peakRadius) this.face(top, '#b0cf85');
    this.face([...ring].reverse(), '#5c8b50');
  }

  station(tile) {
    const { x, y } = axialToWorld(tile.q, tile.r);
    const spa = tile.station === 'spa', help = tile.station === 'helpdesk';
    if (spa) {
      this.box(x, y, 0, .93, .72, .15, '#b4b8a2', '#dce0c5', '#9da58f');
      this.box(x, y, .155, .75, .55, .025, '#99c9bd', '#b7ded0');
      this.box(x + .33, y + .22, .18, .17, .16, .035, '#e5d6a9', '#fff4d6');
      this.box(x + .43, y - .25, 0, .025, .025, 1.03, '#b9a17b');
      const rim = Array.from({ length: 8 }, (_, i) => ({ x: x + .43 + Math.cos(i * TAU / 8) * .43, y: y - .25 + Math.sin(i * TAU / 8) * .43, z: .91 }));
      for (let i = 0; i < 8; i++) this.face([rim[i], rim[(i + 1) % 8], { x: x + .43, y: y - .25, z: 1.12 }], i % 2 ? '#b3a0bf' : '#cbbbce');
    } else if (tile.station === 'test' || tile.station === 'review') {
      const testing = tile.station === 'test';
      const accent = testing ? '#78aaa4' : '#c59573';
      const trim = testing ? '#5f9290' : '#a9765e';
      for (const side of [-1, 1]) this.box(x + side * .51, y - .27, 0, .065, .085, 1.26, '#b48c5c', '#d1ad7a');
      this.box(x, y - .27, .52, 1.05, .13, .62, testing ? '#91b4aa' : '#c19b75', '#f7efdc');
      this.box(x, y - .18, .62, .75, .035, .43, '#f8f1df');
      this.box(x, y - .1, 1.17, 1.42, .65, .12, trim, accent);
      this.box(x, y + .16, 0, 1.15, .43, .51, '#b48b60', '#e8cf9f', '#957150');
      this.box(x, y + .16, .51, 1.18, .47, .055, '#caa577', '#f1d7a7');
      for (let i = 0; i < 3; i++) {
        const px = x - .31 + i * .25;
        if (testing) this.box(px, y + .17, .57, .11, .11, .20, ['#84b9ae', '#d7bd81', '#9eb7d1'][i], '#e4ead7');
        else this.box(px, y + .16, .57 + i * .02, .18, .19, .018, '#fff5dc', '#f8efd8');
      }
      if (!testing) this.box(x + .36, y + .17, .57, .14, .14, .11, '#9c785f', '#bc9874');
    } else {
      for (const side of [-1, 1]) {
        this.box(x + side * .38, y, 0, .07, .34, .38, '#a17b50', '#c5a578', '#876642');
        this.box(x + side * .46, y - .25, 0, .045, .045, 1.06, '#ad8959');
      }
      this.box(x, y, .36, .98, .48, .08, '#bc9a67', '#ecd5a2', '#9e7b4c');
      this.box(x, y - .26, .59, .74, .045, .34, '#d6c797', '#ece1b8', '#b3a47d');
      this.box(x, y - .1, 1.03, 1.12, .78, .08, help ? '#82a9ac' : '#71945a', help ? '#b3cecc' : '#adc683', '#597a52');
      for (let i = 0; i < 3; i++) this.box(x - .22 + i * .22, y - .22, .66, .15, .012, .16, ['#fff2c9', '#e5c99f', '#e9dba8'][i]);
      this.box(x + .22, y + .06, .44, .17, .13, .025, '#f8ebc6');
      this.box(x - .26, y + .05, .44, .1, .1, .12, help ? '#8fb7b7' : '#b28d65');
    }
  }

  actor(actor, time) {
    const { x, y } = actor;
    const swing = actor.moving ? Math.sin(time * 7 + actor.phase) * .055 : 0;
    const z = actor.status === 'sleeping' ? -.16 : 0;
    for (const side of [-1, 1]) {
      this.box(x + side * .075, y + side * swing, z + .015, .09, .115, .18, '#526662', '#748c7d');
      this.box(x + side * .19, y - side * swing, z + .22, .065, .09, .2, actor.color, actor.light);
    }
    this.box(x, y, z + .19, .27, .17, .25, actor.color, actor.light, actor.color);
    this.box(x, y, z + .47, .3, .24, .22, '#e8e6cd', '#fff6da', '#c6ccb7');
    // A visor on both sides makes the tiny companions readable from any direction.
    for (const side of [-1, 1]) {
      this.box(x, y + side * .123, z + .53, .22, .008, .09, '#415f60');
      for (const eye of [-1, 1]) this.box(x + eye * .058, y + side * .13, z + .56, .026, .009, .025, '#e1edb9');
    }
    this.box(x, y, z + .69, .018, .018, .07, '#657f6a');
    this.box(x, y, z + .76, .055, .055, .04, actor.light);
  }

  draw(time) {
    const r = this.renderer, ctx = r.ctx;
    this.width = r.width; this.height = r.height;
    this.focal = Math.min(this.width * .65, this.height * .82);
    this.faces = [];
    const sunset = r.time === 'sunset';
    const sky = ctx.createLinearGradient(0, 0, 0, this.height);
    sky.addColorStop(0, sunset ? '#e9b994' : '#a7d8db');
    sky.addColorStop(.65, sunset ? '#ffebca' : '#edf3d8');
    sky.addColorStop(1, '#c9e0c0');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, this.width, this.height);
    const horizon = this.height / 2 + Math.tan(r.explorer.player.pitch) * this.focal;
    const oceanTop = Math.max(0, Math.min(this.height, horizon));
    const ocean = ctx.createLinearGradient(0, oceanTop, 0, Math.max(oceanTop + 1, this.height));
    ocean.addColorStop(0, sunset ? '#b8cfb9' : '#a4cfca'); ocean.addColorStop(1, '#78b9af');
    ctx.fillStyle = ocean; ctx.fillRect(0, oceanTop, this.width, this.height - oceanTop);
    const sun = this.project(-24, -30, 20);
    if (sun) {
      ctx.fillStyle = '#fff4cc'; ctx.beginPath(); ctx.arc(sun.x, sun.y, 28, 0, TAU); ctx.fill();
    }
    // Ocean ripples are world-anchored, so the sea moves with the camera.
    const ground = [];
    for (let x = -12; x <= 12; x += 2) for (let y = -12; y <= 12; y += 2) {
      const wave = Math.sin(time * .7 + x + y) * .12;
      this.face([{ x, y: y + wave, z: -.4 }, { x: x + .65, y: y + wave, z: -.4 }, { x: x + .65, y: y + wave + .025, z: -.4 }, { x, y: y + wave + .025, z: -.4 }], '#c2e0d0', ground);
    }
    this.paint(ground); ground.length = 0;
    for (const tile of r.world.values()) {
      const center = axialToWorld(tile.q, tile.r);
      const corners = Array.from({ length: 6 }, (_, i) => ({ x: center.x + Math.cos(i * TAU / 6), y: center.y + Math.sin(i * TAU / 6), z: 0 }));
      this.face(corners, GRASS[tile.terrain], ground);
      for (let i = 0; i < 6; i++) {
        const a = corners[i], b = corners[(i + 1) % 6];
        this.face([a, b, { ...b, z: -.38 }, { ...a, z: -.38 }], i % 2 ? '#b18b5c' : '#c4a06e', ground);
      }
      const decorations = r.decorations.get(`${tile.q},${tile.r}`)?.decorations || [];
      for (const item of decorations) {
        const x = center.x + item.x, y = center.y + item.y, s = item.scale;
        if (item.type === 'tree') {
          this.box(x, y, 0, .09 * s, .09 * s, .78 * s, '#9c8055', '#b49a6c', '#826d4b');
          if (item.variant === 'pine') {
            this.crown(x, y, .45 * s, .43 * s, .65 * s, '#6e9e5f');
            this.crown(x, y, .8 * s, .32 * s, .63 * s, '#85ac68');
          } else {
            this.crown(x, y, .6 * s, .43 * s, .42 * s, '#86af63', .34 * s);
            this.crown(x, y, 1.02 * s, .34 * s, .35 * s, '#91b76a', .10 * s);
          }
        } else if (item.type === 'rock') {
          this.box(x, y, 0, s * .65, s * .55, s * .37, '#99aa94', '#c8ceaf', '#899e8c');
        } else if (item.type === 'flower') {
          this.box(x, y, 0, .012, .012, .11 * s, '#749553');
          this.box(x, y, .11 * s, .055 * s, .055 * s, .022, ['#fff3ce', '#efce73', '#e8b0ac', '#b9add4'][item.color]);
        } else {
          const sway = Math.sin(time + x * 5) * .015;
          this.face([{ x: x - .025, y, z: 0 }, { x: x + .025, y, z: 0 }, { x: x + sway, y, z: .065 * s }], '#82a65e');
        }
      }
      if (tile.station) this.station(tile);
    }
    this.paint(ground);
    const actors = r.explorer.getActors();
    actors.forEach(actor => this.actor(actor, time));
    this.paint(this.faces);
    for (const tile of r.world.values()) if (tile.station) {
      const { x, y } = axialToWorld(tile.q, tile.r);
      this.label(x, y, tile.station === 'spa' ? .7 : 1.35, STATIONS[tile.station].name);
    }
    for (const actor of actors) this.label(actor.x, actor.y, .94, actor.name);
    this.minimap(actors);
  }

  label(x, y, z, text) {
    const p = this.project(x, y, z);
    if (!p || p.depth > 7 || p.x < 20 || p.x > this.width - 20 || p.y < 80 || p.y > this.height - 70) return;
    const ctx = this.renderer.ctx;
    ctx.font = '11px "Trebuchet MS", sans-serif'; ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 20;
    ctx.fillStyle = '#fffbeddf'; ctx.beginPath(); ctx.roundRect(p.x - w / 2, p.y - 13, w, 24, 12); ctx.fill();
    ctx.fillStyle = '#48644f'; ctx.fillText(text, p.x, p.y + 3);
  }

  minimap(actors) {
    const r = this.renderer, ctx = r.ctx, player = r.explorer.player;
    const size = this.width < 650 ? 100 : 138, left = this.width - size - 22, top = this.width < 650 ? 82 : 105;
    const positions = [...r.world.values()].map(tile => ({ ...axialToWorld(tile.q, tile.r), tile }));
    const minX = Math.min(...positions.map(p => p.x)) - 1, maxX = Math.max(...positions.map(p => p.x)) + 1;
    const minY = Math.min(...positions.map(p => p.y)) - 1, maxY = Math.max(...positions.map(p => p.y)) + 1;
    const scale = (size - 18) / Math.max(maxX - minX, maxY - minY);
    const map = (x, y) => ({ x: left + size / 2 + (x - (minX + maxX) / 2) * scale, y: top + size / 2 + (y - (minY + maxY) / 2) * scale });
    ctx.save(); ctx.fillStyle = '#fffcedd9'; ctx.beginPath(); ctx.roundRect(left, top, size, size + 24, 16); ctx.fill();
    for (const p of positions) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const c = map(p.x + Math.cos(i * TAU / 6) * .94, p.y + Math.sin(i * TAU / 6) * .94); i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y); }
      ctx.closePath(); ctx.fillStyle = GRASS[p.tile.terrain]; ctx.fill();
      if (p.tile.station) { const c = map(p.x, p.y); ctx.fillStyle = '#8c7656'; ctx.fillRect(c.x - 2, c.y - 2, 4, 4); }
    }
    for (const actor of actors) { const p = map(actor.x, actor.y); ctx.fillStyle = actor.color; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, TAU); ctx.fill(); }
    const p = map(player.x, player.y);
    ctx.translate(p.x, p.y); ctx.rotate(player.yaw); ctx.fillStyle = '#315e51'; ctx.strokeStyle = '#fff9dc'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore(); ctx.font = '10px "Trebuchet MS", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#5c7860'; ctx.fillText('YOU & THE ISLAND', left + size / 2, top + size + 12);
  }
}
