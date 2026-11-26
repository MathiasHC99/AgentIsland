import { createWorld, addTile, paintTile, summarizeWorld, hexKey, STATIONS } from './world/world.js';
import { IslandRenderer } from './world/renderer.js';
import { initWorkbench } from './ui/workbench.js';
import { createBoardStore } from './state/board-store.js';
import { createNotificationQueue } from './state/notification-queue.js';
import { initStations } from './ui/station-ui.js';
import { initQualityStations } from './ui/quality-ui.js';
import { IslandExplorer } from './world/explorer.js';
import { initShowcase } from './ui/showcase-ui.js';
import { initNoticeboard } from './ui/noticeboard-ui.js';
import { initHelpdeskWorker } from './agents/helpdesk-worker.js';
import { syncSeedTodos } from './domain/jobs.js';
import { seedTodos } from './todo-seed.js';

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
let workbench;
let stations;
let qualityStations;
let explorer;
let showcase;
let noticeboard;
let helpdeskWorker;
let celebrationTimer;
const notificationQueue = createNotificationQueue();
const boardStore = createBoardStore({ onJobEvent: event => {
  notificationQueue.add(event);
  if (event.type === 'completed') celebrate();
} });
void boardStore.mutate(board => syncSeedTodos(board, seedTodos));
void notificationQueue.flush();
setInterval(() => { void notificationQueue.flush(); }, 30_000);
window.addEventListener('online', () => { void notificationQueue.flush(); });

function announce(message) {
  const element = $('#announcement');
  clearTimeout(announcementTimer);
  element.textContent = message;
  element.classList.add('visible');
  announcementTimer = setTimeout(() => element.classList.remove('visible'), 1900);
}

function celebrate() {
  const display = $('#celebration');
  clearTimeout(celebrationTimer);
  display.classList.remove('visible');
  void display.offsetWidth;
  display.classList.add('visible');
  celebrationTimer = setTimeout(() => display.classList.remove('visible'), 2100);
  announce('A new project joins the showcase!');
}

function refreshWorld() {
  renderer.setWorld(world);
  $('#tile-count').textContent = summarizeWorld(world).tiles;
  $('#undo').disabled = undoStack.length === 0;
}

const renderer = new IslandRenderer(canvas, {
  onTileClick(tile) {
    if (tool === 'explore' && tile.station) {
      if (tile.station === 'workbench') workbench.open();
      else if (tile.station === 'helpdesk' || tile.station === 'spa') stations.open(tile.station);
      else qualityStations.open(tile.station);
      return;
    }
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
    if (tile) $('#tile-name').textContent = tile.station ? `Hex ${String(tile.number).padStart(2, '0')} · ${STATIONS[tile.station]?.name || 'Station'} · Tap to open` : names[tile.terrain] || 'Room for something new';
  },
  onViewChange(value) {
    const zoom = typeof value === 'number' ? value : value?.zoom ?? renderer.zoom ?? 1;
    $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  },
});

function prepareStation() {
  explorer?.pause();
  document.querySelectorAll('dialog[open]').forEach(panel => panel.close());
  showHelp(false);
  setTool('explore');
}
workbench = initWorkbench({ renderer, store: boardStore, onBeforeOpen: prepareStation,
  notifyHuman: event => notificationQueue.add(event),
  onDreaming: active => explorer?.setDreaming(active) });
stations = initStations({ renderer, store: boardStore, onBeforeOpen: prepareStation,
  openWorkbench: () => workbench.open(), onSpaOpen: () => workbench.onSpaOpen() });
qualityStations = initQualityStations({ renderer, store: boardStore, onBeforeOpen: prepareStation });
showcase = initShowcase({ store: boardStore, onBeforeOpen: prepareStation });
noticeboard = initNoticeboard({ store: boardStore, onBeforeOpen: prepareStation,
  getModel: () => workbench.selectedModel() });
helpdeskWorker = initHelpdeskWorker({ store: boardStore,
  notifyHuman: event => notificationQueue.add(event),
  onResolved: (jobId, guidance, model) => workbench.runJob(jobId, model, `Helpdesk guidance: ${guidance}`) });

function setTool(next) {
  if (explorer?.active && next !== 'explore') explorer.exit();
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
  document.body.classList.toggle('breeze-off', !motion);
  $('#motion-toggle').textContent = motion ? 'Breeze on' : 'Breeze off';
  $('#motion-toggle').setAttribute('aria-pressed', String(motion));
}
$('#motion-toggle').addEventListener('click', () => { motion = !motion; updateMotion(); });
reducedMotion.addEventListener('change', event => { motion = !event.matches; updateMotion(); });
function showHelp(show) {
  if (show) explorer?.pause();
  $('#help-panel').hidden = !show;
  $('#help-button').setAttribute('aria-expanded', String(show));
}
$('#help-button').addEventListener('click', () => showHelp($('#help-panel').hidden));
$('#close-help').addEventListener('click', () => showHelp(false));
document.addEventListener('keydown', event => {
  const openPanel = document.querySelector('dialog[open]');
  if (openPanel) {
    if (event.key === 'Escape') { event.preventDefault(); openPanel.close(); }
    return;
  }
  if (explorer?.active) {
    if (event.key === '?' && !event.repeat) showHelp($('#help-panel').hidden);
    return;
  }
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
explorer = new IslandExplorer(renderer, {
  onEnter() { document.querySelectorAll('dialog[open]').forEach(panel => panel.close()); showHelp(false); setTool('explore'); },
  openStation(station) {
    if (station === 'workbench') workbench.open();
    else if (station === 'helpdesk' || station === 'spa') stations.open(station);
    else qualityStations.open(station);
  },
});
explorer.setBoard(boardStore.getBoard());
const unsubscribeExplorer = boardStore.subscribe(board => explorer.setBoard(board));
updateMotion();
window.addEventListener('pagehide', () => { clearTimeout(announcementTimer); clearTimeout(celebrationTimer); unsubscribeExplorer(); helpdeskWorker.destroy(); explorer.destroy(); workbench.destroy(); stations.destroy(); qualityStations.destroy(); showcase.destroy(); noticeboard.destroy(); boardStore.destroy(); renderer.destroy(); }, { once: true });
