import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRAINS, START_HEX, STATIONS, createWorld, hexKey, neighbors, axialToWorld, frontierTiles,
  addTile, paintTile, summarizeWorld, seededRandom,
} from '../src/client/world/world.js';

test('initial island is stable, contiguous, varied, and bounded to a small footprint', () => {
  const world = createWorld('test-island');
  assert.equal(world.size, 23);
  assert.deepEqual([...world], [...createWorld('test-island')]);
  assert.notDeepEqual([...world], [...createWorld('another-island')]);
  assert.deepEqual(new Set([...world.values()].map(tile => tile.terrain)), new Set(TERRAINS));
  const pending = [world.values().next().value];
  const visited = new Set();
  while (pending.length) {
    const tile = pending.pop();
    const key = hexKey(tile.q, tile.r);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const neighbor of neighbors(tile.q, tile.r)) {
      const candidate = world.get(hexKey(neighbor.q, neighbor.r));
      if (candidate) pending.push(candidate);
    }
  }
  assert.equal(visited.size, world.size);
  for (const [key, tile] of world) {
    assert.equal(key, hexKey(tile.q, tile.r));
    assert.ok(Math.max(Math.abs(tile.q), Math.abs(tile.r), Math.abs(tile.q + tile.r)) <= 3);
    assert.ok(Number.isInteger(tile.seed));
  }
});

test('all six neighbors project to touching hex centers at every radius', () => {
  const origin = { q: 3, r: -7 };
  assert.equal(new Set(neighbors(origin.q, origin.r).map(p => hexKey(p.q, p.r))).size, 6);
  for (const size of [0.5, 1, 42]) {
    const center = axialToWorld(origin.q, origin.r, size);
    for (const neighbor of neighbors(origin.q, origin.r)) {
      const position = axialToWorld(neighbor.q, neighbor.r, size);
      assert.ok(Math.abs(Math.hypot(position.x - center.x, position.y - center.y) - Math.sqrt(3) * size) < 1e-10);
    }
  }
});

test('all five stations have distinct anchored tiles and survive paint and expansion', () => {
  const world = createWorld();
  const previous = Object.entries(STATIONS).map(([id, position]) => {
    const tile = world.get(hexKey(position.q, position.r));
    assert.equal(tile.station, id);
    assert.ok(tile.number > 0);
    return { ...tile };
  });
  assert.equal(previous.length, 5);
  assert.equal(new Set(previous.map(tile => hexKey(tile.q, tile.r))).size, 5);
  assert.equal(previous[0].number, 1);
  for (const tile of previous) {
    const painted = paintTile(world, tile.q, tile.r, 'grove');
    assert.equal(painted.station, tile.station);
    assert.equal(painted.number, tile.number);
  }
  const frontier = frontierTiles(world)[0];
  addTile(world, frontier.q, frontier.r);
  for (const tile of previous) assert.equal(world.get(hexKey(tile.q, tile.r)).station, tile.station);
});

test('hex 01 is the anchored starting workbench and survives terrain edits and expansion', () => {
  const world = createWorld();
  assert.deepEqual(START_HEX, { q: 0, r: 0, number: 1 });
  assert.equal(world.values().next().value, world.get('0,0'));
  assert.equal(world.get('0,0').station, 'workbench');
  assert.equal(world.get('0,0').number, 1);
  assert.equal([...world.values()].filter(tile => tile.station === 'workbench').length, 1);
  assert.equal(new Set([...world.values()].map(tile => tile.number)).size, 23);
  paintTile(world, 0, 0, 'grove');
  assert.equal(world.get('0,0').station, 'workbench');
  assert.equal(world.get('0,0').number, 1);
  const next = frontierTiles(world)[0];
  assert.equal(addTile(world, next.q, next.r).number, 24);
  assert.equal(world.get('0,0').station, 'workbench');
});

test('frontier consists of unique adjacent empty positions and does not mutate the world', () => {
  const world = createWorld();
  const before = structuredClone(world);
  const frontier = frontierTiles(world);
  assert.ok(frontier.length > 0);
  assert.equal(new Set(frontier.map(p => hexKey(p.q, p.r))).size, frontier.length);
  for (const position of frontier) {
    assert.equal(world.has(hexKey(position.q, position.r)), false);
    assert.ok(neighbors(position.q, position.r).some(p => world.has(hexKey(p.q, p.r))));
  }
  assert.deepEqual(world, before);
});

test('expansion preserves existing tiles and rejects duplicates, gaps, and invalid input', () => {
  const world = createWorld();
  const previousTiles = [...world];
  const target = frontierTiles(world)[0];
  const tile = addTile(world, target.q, target.r, 'grove');
  assert.equal(world.size, 24);
  assert.equal(tile.terrain, 'grove');
  for (const [key, previous] of previousTiles) assert.equal(world.get(key), previous);
  assert.equal(addTile(world, target.q, target.r), null);
  assert.equal(addTile(world, 100, 100), null);
  assert.equal(addTile(world, NaN, 0), null);
  assert.equal(addTile(world, 1.5, 0), null);
  assert.equal(addTile(world, Infinity, 0), null);
  assert.equal(addTile(world, 0, 0, 'ocean'), null);
  assert.equal(world.size, 24);
});

test('a first tile can initialize an empty world', () => {
  const world = new Map();
  assert.deepEqual(frontierTiles(world), []);
  assert.ok(addTile(world, -4, 2, 'meadow'));
  assert.equal(world.size, 1);
});

test('painting changes only terrain and summary counts reflect edits', () => {
  const world = createWorld();
  const previous = world.get('0,0');
  const tile = paintTile(world, 0, 0, 'wildflowers');
  assert.deepEqual(tile, { ...previous, terrain: 'wildflowers' });
  assert.equal(previous.terrain, 'meadow');
  assert.equal(paintTile(world, 100, 100, 'grove'), null);
  assert.equal(paintTile(world, 0, 0, 'invalid'), null);
  const summary = summarizeWorld(world);
  assert.equal(summary.tiles, world.size);
  assert.equal(summary.groves, summary.terrain.grove);
  assert.equal(Object.values(summary.terrain).reduce((sum, count) => sum + count, 0), world.size);
});

test('procedural random streams repeat and remain in range', () => {
  const a = seededRandom('decorations');
  const b = seededRandom('decorations');
  for (let count = 0; count < 1000; count += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});
