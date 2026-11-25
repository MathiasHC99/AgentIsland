import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, axialToWorld, addTile } from '../dist/world.js';
import { IslandPlayer, tileAt, canOccupy } from '../dist/player.js';

const step = (player, input, frames = 60) => { for (let i = 0; i < frames; i++) player.update(1 / 60, input); };

test('world positions resolve to their hex, including negative coordinates and seams', () => {
  const world = createWorld();
  for (const tile of world.values()) {
    const p = axialToWorld(tile.q, tile.r);
    assert.equal(tileAt(world, p.x, p.y), tile);
    assert.equal(tileAt(world, p.x + .98, p.y), tile);
  }
  assert.equal(tileAt(world, 50, 50), null);
  assert.ok(tileAt(world, 0, Math.sqrt(3) / 2 - .001));
  assert.ok(tileAt(world, 0, Math.sqrt(3) / 2 + .001));
});

test('camera-relative movement normalizes diagonals and sprint increases speed', () => {
  const world = createWorld();
  const forward = new IslandPlayer(world), diagonal = new IslandPlayer(world), sprint = new IslandPlayer(world);
  for (const p of [forward, diagonal, sprint]) { p.x = 0; p.y = 0; }
  step(forward, { forward: 1 }, 30);
  step(diagonal, { forward: 1, right: 1 }, 30);
  step(sprint, { forward: 1, sprint: true }, 30);
  assert.ok(Math.abs(Math.hypot(forward.x, forward.y) - Math.hypot(diagonal.x, diagonal.y)) < 1e-8);
  assert.ok(Math.hypot(sprint.x, sprint.y) > Math.hypot(forward.x, forward.y) * 1.9);
  const turned = new IslandPlayer(world); turned.x = 0; turned.y = 0; turned.yaw = Math.PI / 2;
  step(turned, { forward: 1 }, 30);
  assert.ok(turned.x > .5 && Math.abs(turned.y) < 1e-8);
});

test('walking stays on land and cannot tunnel through solid props', () => {
  const world = new Map([['0,0', { q: 0, r: 0 }]]);
  const player = new IslandPlayer(world, [{ x: 0, y: 0, radius: .3 }]);
  step(player, { forward: 1, sprint: true }, 600);
  assert.ok(player.y >= .41 - 1e-8);
  assert.ok(canOccupy(world, player.obstacles, player.x, player.y));
  step(player, { forward: -1, sprint: true }, 600);
  assert.ok(player.y < Math.sqrt(3) / 2);
  assert.ok(canOccupy(world, player.obstacles, player.x, player.y));
  assert.equal(canOccupy(world, [], 0, Math.sqrt(3) / 2 - .02), false);
});

test('a shared hex boundary is walkable and newly added land becomes traversable', () => {
  const world = new Map([['0,0', { q: 0, r: 0 }]]);
  const player = new IslandPlayer(world);
  step(player, { forward: -1 }, 60);
  const before = player.y;
  assert.ok(addTile(world, 0, 1));
  player.setWorld(world, []);
  step(player, { forward: -1 }, 60);
  assert.ok(player.y > before + 1);
  assert.equal(tileAt(world, player.x, player.y).r, 1);
});

test('jump lands, cannot double-jump, and frame stalls do not teleport the player', () => {
  const player = new IslandPlayer(createWorld());
  player.jump(); step(player, {}, 8);
  assert.ok(player.z > 0);
  const velocity = player.velocityZ; player.jump(); assert.equal(player.velocityZ, velocity);
  step(player, {}, 100); assert.equal(player.z, 0); assert.equal(player.velocityZ, 0);
  const y = player.y; player.update(90, { forward: -1 }); assert.ok(Math.abs(player.y - y) <= .056);
  player.look(0, 100); assert.equal(player.pitch, -1.05);
  player.look(0, -100); assert.equal(player.pitch, 1.05);
});

test('station proximity uses world positions and deleted ground safely respawns the player', () => {
  const world = createWorld(), player = new IslandPlayer(world);
  assert.equal(player.nearbyStation().station, 'workbench');
  const spa = axialToWorld(1, 1); player.x = spa.x + .7; player.y = spa.y;
  assert.equal(player.nearbyStation().station, 'spa');
  player.x = 0; player.y = 5.2;
  world.delete('0,3'); player.setWorld(world, []);
  assert.ok(canOccupy(world, [], player.x, player.y));
});
