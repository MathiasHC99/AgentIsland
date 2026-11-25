/** Small, renderer-independent model of an expandable flat-top hex island. */
export const TERRAINS = Object.freeze(['meadow', 'grove', 'wildflowers', 'earth']);
export const START_HEX = Object.freeze({ q: 0, r: 0, number: 1 });
export const STATIONS = Object.freeze({
  workbench: Object.freeze({ name: 'Workbench', q: 0, r: 0 }),
  helpdesk: Object.freeze({ name: 'Helpdesk', q: -2, r: 1 }),
  spa: Object.freeze({ name: 'Spa', q: 1, r: 1 }),
  test: Object.freeze({ name: 'Test station', q: 1, r: -1 }),
  review: Object.freeze({ name: 'Review station', q: 2, r: -1 }),
});

const DIRECTIONS = Object.freeze([
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]);

const validCoordinate = (q, r) => Number.isSafeInteger(q) && Number.isSafeInteger(r);
const validTerrain = terrain => TERRAINS.includes(terrain);

export function hexKey(q, r) {
  return `${q},${r}`;
}

/** Stable unsigned hash; useful for deterministic procedural decoration. */
export function hash(...parts) {
  const input = parts.map(String).join('|');
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Independent random stream with values in [0, 1). */
export function seededRandom(seed = 1) {
  let state = hash(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat-top axial projection onto the ground plane. */
export function axialToWorld(q, r, size = 1) {
  return { x: size * 1.5 * q, y: size * Math.sqrt(3) * (r + q / 2) };
}

export function neighbors(q, r) {
  if (!validCoordinate(q, r)) return [];
  return DIRECTIONS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }))
    .filter(position => validCoordinate(position.q, position.r));
}

function makeTile(q, r, terrain, seed) {
  return { q, r, terrain, seed: hash(seed, q, r) };
}

/** A deliberately small, irregular island with open ground and wooded corners. */
export function createWorld(seed = 'agent-island') {
  const world = new Map();
  const random = seededRandom(seed);
  world.set(hexKey(START_HEX.q, START_HEX.r), {
    ...makeTile(START_HEX.q, START_HEX.r, 'meadow', seed),
    number: START_HEX.number,
    station: 'workbench',
  });
  for (let q = -2; q <= 2; q += 1) {
    for (let r = -2; r <= 2; r += 1) {
      if (Math.abs(q + r) > 2) continue;
      const roll = random();
      let terrain = 'meadow';
      if ((q < 0 && r <= 0) || (q === 1 && r === -2)) terrain = 'grove';
      else if ((q > 0 && r >= 0) || roll < 0.2) terrain = 'wildflowers';
      if (q === 0 && r === 0) terrain = 'meadow';
      if (q === 1 && r === 0) terrain = 'earth';
      if (q !== START_HEX.q || r !== START_HEX.r) {
        world.set(hexKey(q, r), { ...makeTile(q, r, terrain, seed), number: world.size + 1 });
      }
    }
  }
  for (const [q, r, terrain] of [
    [-3, 1, 'grove'], [-3, 2, 'meadow'], [0, 3, 'wildflowers'], [2, -3, 'meadow'],
  ]) {
    world.set(hexKey(q, r), { ...makeTile(q, r, terrain, seed), number: world.size + 1 });
  }
  for (const [station, position] of Object.entries(STATIONS)) {
    const key = hexKey(position.q, position.r);
    world.set(key, { ...world.get(key), station, terrain: 'meadow' });
  }
  return world;
}

/** Each unoccupied adjacent coordinate appears once, in a stable order. */
export function frontierTiles(world) {
  const frontier = new Map();
  for (const tile of world.values()) {
    for (const position of neighbors(tile.q, tile.r)) {
      const key = hexKey(position.q, position.r);
      if (!world.has(key)) frontier.set(key, position);
    }
  }
  return [...frontier.values()].sort((a, b) => a.q - b.q || a.r - b.r);
}

/** Add to the island edge only. An empty world accepts its first tile anywhere. */
export function addTile(world, q, r, terrain = 'meadow') {
  if (!validCoordinate(q, r) || !validTerrain(terrain) || world.has(hexKey(q, r))) return null;
  if (world.size > 0 && !neighbors(q, r).some(position => world.has(hexKey(position.q, position.r)))) {
    return null;
  }
  const number = Math.max(0, ...Array.from(world.values(), tile => tile.number || 0)) + 1;
  const tile = { ...makeTile(q, r, terrain, 'new-island-tile'), number };
  world.set(hexKey(q, r), tile);
  return tile;
}

/** Change a tile's terrain while preserving its identity and decoration seed. */
export function paintTile(world, q, r, terrain) {
  if (!validCoordinate(q, r) || !validTerrain(terrain)) return null;
  const existing = world.get(hexKey(q, r));
  if (!existing) return null;
  const tile = { ...existing, terrain };
  world.set(hexKey(q, r), tile);
  return tile;
}

export function summarizeWorld(world) {
  const terrain = Object.fromEntries(TERRAINS.map(type => [type, 0]));
  for (const tile of world.values()) terrain[tile.terrain] += 1;
  return { tiles: world.size, groves: terrain.grove, terrain };
}
