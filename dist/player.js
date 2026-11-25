import { axialToWorld, hexKey } from './world.js';

export const PLAYER_RADIUS = .11;
export const EYE_HEIGHT = .68;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Inverse flat-top hex projection, with cube rounding at shared edges. */
export function tileAt(world, x, y) {
  const q = x * 2 / 3, r = -x / 3 + y / Math.sqrt(3), s = -q - r;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return world.get(hexKey(rq, rr)) || null;
}

export function canOccupy(world, obstacles, x, y, radius = PLAYER_RADIUS) {
  if (!tileAt(world, x, y)) return false;
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    if (!tileAt(world, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) return false;
  }
  return !obstacles.some(item => Math.hypot(x - item.x, y - item.y) < radius + item.radius);
}

export class IslandPlayer {
  constructor(world, obstacles = []) {
    this.world = world;
    this.obstacles = obstacles;
    this.yaw = 0;
    this.pitch = -.12;
    this.z = 0;
    this.velocityZ = 0;
    this.distance = 0;
    this.moving = false;
    this.respawn();
  }

  respawn() {
    // Prefer the open approach to Hex 01. Also supports undoing land underfoot.
    const tiles = [...this.world.values()].sort((a, b) => (a.number || 0) - (b.number || 0));
    for (const tile of tiles) {
      const center = axialToWorld(tile.q, tile.r);
      for (const offset of [{ x: 0, y: 1.45 }, { x: 0, y: .72 }, { x: .65, y: 0 }, { x: 0, y: 0 }]) {
        const x = center.x + offset.x, y = center.y + offset.y;
        if (canOccupy(this.world, this.obstacles, x, y)) {
          Object.assign(this, { x, y, z: 0, velocityZ: 0 });
          return true;
        }
      }
    }
    return false;
  }

  setWorld(world, obstacles) {
    this.world = world;
    this.obstacles = obstacles;
    if (!canOccupy(world, obstacles, this.x, this.y)) this.respawn();
  }

  look(dx, dy) {
    this.yaw = (this.yaw + dx) % (Math.PI * 2);
    this.pitch = clamp(this.pitch - dy, -1.05, 1.05);
  }

  jump() {
    if (this.z === 0) this.velocityZ = 1.65;
  }

  update(seconds, { forward = 0, right = 0, sprint = false, turn = 0, look = 0 } = {}) {
    const dt = clamp(seconds, 0, .05);
    this.look(turn * dt * 1.9, look * dt * 1.4);
    const length = Math.max(1, Math.hypot(forward, right));
    const speed = (sprint ? 2.15 : 1.1) * dt / length;
    const dx = (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right) * speed;
    const dy = (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * right) * speed;
    const startX = this.x, startY = this.y;
    // Small steps prevent tunnelling; independent axes allow sliding along props.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / .035));
    for (let i = 0; i < steps; i++) {
      if (canOccupy(this.world, this.obstacles, this.x + dx / steps, this.y)) this.x += dx / steps;
      if (canOccupy(this.world, this.obstacles, this.x, this.y + dy / steps)) this.y += dy / steps;
    }
    const distance = Math.hypot(this.x - startX, this.y - startY);
    this.moving = distance > .0001;
    this.distance += distance;
    if (this.velocityZ || this.z) {
      this.z = Math.max(0, this.z + this.velocityZ * dt);
      this.velocityZ -= 4.8 * dt;
      if (!this.z && this.velocityZ < 0) this.velocityZ = 0;
    }
  }

  nearbyStation(maxDistance = 1.65) {
    let nearest = null, distance = maxDistance;
    for (const tile of this.world.values()) {
      if (!tile.station) continue;
      const p = axialToWorld(tile.q, tile.r);
      const next = Math.hypot(p.x - this.x, p.y - this.y);
      if (next < distance) { nearest = tile; distance = next; }
    }
    return nearest;
  }
}
