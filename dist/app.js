import { createWorld, addTile, paintTile, summarizeWorld, hexKey } from './world.js';
import { IslandRenderer } from './renderer.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#island');
const world = createWorld();
const undoStack = [];
const names = { meadow: 'A soft green meadow', grove: 'A little woodland', wildflowers: 'A patch of wildflowers', earth: 'Good, honest earth' };
let tool = 'explore';
let terrain = 'meadow';
let sunset = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let motion = !reducedMotion.matches;
let announcementTimer;

function announce(message) {
  const element = $('#announcement');
  clearTimeout(announcementTimer);
  element.textContent = message;
  element.classList.add('visible');
  announcementTimer = setTimeout(() => element.classList.remove('visible'), 1900);
}

function refreshWorld() {
  renderer.setWorld(world);
  $('#tile-count').textContent = summarizeWorld(world).tiles;
  $('#undo').disabled = undoStack.length === 0;
}

const renderer = new IslandRenderer(canvas, {
  onTileClick(tile) {
    if (tool !== 'paint' || tile.terrain === terrain) return;
    const previous = { ...tile };
    if (paintTile(world, tile.q, tile.r, terrain)) {
      undoStack.push({ kind: 'paint', previous });
      refreshWorld();
      announce(terrain === 'grove' ? 'A little woodland takes root.' : terrain === 'wildflowers' ? 'A little more colour in the world.' : 'A fresh look for this little patch.');
    }
  },
  onFrontierClick({ q, r }) {
    if (tool !== 'expand') return;
    if (addTile(world, q, r, terrain)) {
      undoStack.push({ kind: 'add', key: hexKey(q, r) });
      refreshWorld();
      announce('A little more room to grow.');
    }
  },
  onHover(tile) {
    $('#tile-label').hidden = !tile;
    if (tile) $('#tile-name').textContent = names[tile.terrain] || 'Room for something new';
  },
  onViewChange(value) {
    const zoom = typeof value === 'number' ? value : value?.zoom ?? renderer.zoom ?? 1;
    $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  },
});

function setTool(next) {
  tool = next;
  renderer.setTool(next);
  document.querySelectorAll('[data-tool]').forEach(button => {
    const active = button.dataset.tool === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#palette').hidden = next === 'explore';
  $('#tool-hint').textContent = { explore: 'Take a moment. Have a look around.', expand: 'Choose a patch. Tap a + to grow your island.', paint: 'Choose a patch. Tap a hexagon to make it yours.' }[next];
}

function undo() {
  const change = undoStack.pop();
  if (!change) return;
  if (change.kind === 'add') world.delete(change.key);
  else world.set(hexKey(change.previous.q, change.previous.r), change.previous);
  refreshWorld();
  announce('One little step back.');
}

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-terrain]').forEach(button => button.addEventListener('click', () => {
  terrain = button.dataset.terrain;
  renderer.setTerrain(terrain);
  document.querySelectorAll('[data-terrain]').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
}));
$('#undo').addEventListener('click', undo);
$('#zoom-in').addEventListener('click', () => renderer.zoomBy(1.15));
$('#zoom-out').addEventListener('click', () => renderer.zoomBy(1 / 1.15));
$('#reset-view').addEventListener('click', () => renderer.resetView());
$('#time-toggle').addEventListener('click', () => {
  sunset = !sunset;
  document.body.classList.toggle('sunset', sunset);
  renderer.setTime(sunset ? 'sunset' : 'day');
  $('#time-icon').setAttribute('href', sunset ? '#i-moon' : '#i-sun');
  $('#time-toggle').setAttribute('aria-label', sunset ? 'Switch to daylight' : 'Switch to golden hour');
  $('#time-toggle').title = sunset ? 'Switch to daylight' : 'Switch to golden hour';
});
function updateMotion() {
  renderer.setMotion(motion);
  $('#motion-toggle').textContent = motion ? 'Breeze on' : 'Breeze off';
  $('#motion-toggle').setAttribute('aria-pressed', String(motion));
}
$('#motion-toggle').addEventListener('click', () => { motion = !motion; updateMotion(); });
reducedMotion.addEventListener('change', event => { motion = !event.matches; updateMotion(); });
function showHelp(show) {
  $('#help-panel').hidden = !show;
  $('#help-button').setAttribute('aria-expanded', String(show));
}
$('#help-button').addEventListener('click', () => showHelp($('#help-panel').hidden));
$('#close-help').addEventListener('click', () => showHelp(false));
document.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea,select') || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
  if (event.ctrlKey || event.metaKey) return;
  if (['1', '2', '3'].includes(event.key)) setTool({ 1: 'explore', 2: 'expand', 3: 'paint' }[event.key]);
  if (event.key === 'Escape') { showHelp(false); setTool('explore'); }
  if (event.key === '?' && !event.repeat) showHelp($('#help-panel').hidden);
  if (event.key === '+' || event.key === '=') { event.preventDefault(); renderer.zoomBy(1.15); }
  if (event.key === '-') { event.preventDefault(); renderer.zoomBy(1 / 1.15); }
  if (event.key === 'Home') { event.preventDefault(); renderer.resetView(); }
  if (event.key.startsWith('Arrow')) {
    const direction = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] }[event.key];
    if (direction) { event.preventDefault(); renderer.panBy(...direction); }
  }
});

refreshWorld();
updateMotion();
window.addEventListener('pagehide', () => { clearTimeout(announcementTimer); renderer.destroy(); }, { once: true });
