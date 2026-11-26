import { IslandPlayer, canOccupy, tileAt } from './player.js';
import { axialToWorld, STATIONS } from './world.js';
import { TEAM_AGENT_ID, TEAM_STAGES } from '../domain/jobs.js';

const specialists = [
  { name: 'Writer', stage: 'draft', station: 'workbench', color: '#a46b4b', light: '#f0c698', offset: -.66 },
  { name: 'Checker', stage: 'check', station: 'test', color: '#467e80', light: '#b6e1d8', offset: -.65 },
];

const $ = selector => document.querySelector(selector);
const MOVEMENT = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyE']);
const editing = target => target?.closest('input,textarea,select,[contenteditable="true"]');

export class IslandExplorer {
  constructor(renderer, { openStation, onEnter }) {
    this.renderer = renderer;
    this.canvas = renderer.canvas;
    this.openStation = openStation;
    this.onEnter = onEnter;
    this.active = false;
    this.paused = false;
    this.keys = new Set();
    this.touchKeys = new Map();
    this.listeners = [];
    this.clock = 0;
    this.boardAgents = [];
    this.boardJobs = [];
    this.boardHelpRequests = [];
    this.dreaming = false;
    this.player = new IslandPlayer(renderer.world);
    this.companions = [];
    renderer.explorer = this;
    this.syncWorld();
    this.bindEvents();
  }

  listen(element, type, handler, options) {
    element.addEventListener(type, handler, options);
    this.listeners.push(() => element.removeEventListener(type, handler, options));
  }

  syncWorld() {
    const obstacles = [];
    for (const tile of this.renderer.world.values()) {
      const center = axialToWorld(tile.q, tile.r);
      if (tile.station) obstacles.push({ ...center, radius: tile.station === 'spa' ? .5 : .53 });
      const decorations = this.renderer.decorations.get(`${tile.q},${tile.r}`)?.decorations || [];
      for (const item of decorations) if (item.type === 'tree') obstacles.push({ x: center.x + item.x, y: center.y + item.y, radius: .085 * item.scale });
    }
    this.player.setWorld(this.renderer.world, obstacles);
    if (!this.companions.length) {
      const sites = [...this.renderer.world.values()].filter(tile => !tile.station && tile.terrain !== 'grove')
        .map(tile => axialToWorld(tile.q, tile.r)).filter(p => canOccupy(this.renderer.world, obstacles, p.x, p.y));
      this.companions = [
        { name: 'Moss · demo', color: '#789b7d', light: '#b8d29a' },
        { name: 'Pip · demo', color: '#b28c65', light: '#e6c38c' },
      ].map((actor, i) => {
        const preferred = i === 0 ? { x: -1.2, y: 1.1 } : { x: .9, y: 1.05 };
        const home = canOccupy(this.renderer.world, obstacles, preferred.x, preferred.y) ? preferred : sites[i] || { x: 0, y: .72 };
        return { ...actor, home, phase: i * 2.4, moving: false };
      });
    }
    this.renderer.invalidate();
  }

  setBoard(board) {
    this.boardAgents = board.agents;
    this.boardJobs = board.jobs;
    this.boardHelpRequests = board.helpRequests;
    this.renderer.invalidate();
  }

  setDreaming(active) {
    this.dreaming = !!active;
    this.renderer.invalidate();
  }

  getActors() {
    const actors = this.companions.map(actor => {
      const angle = this.clock * .32 + actor.phase;
      const x = actor.home.x + Math.cos(angle) * .36, y = actor.home.y + Math.sin(angle) * .36;
      const valid = canOccupy(this.renderer.world, this.player.obstacles, x, y);
      return { ...actor, x: valid ? x : actor.home.x, y: valid ? y : actor.home.y, moving: this.renderer.motion };
    });
    const dreamerHome = axialToWorld(STATIONS.spa.q, STATIONS.spa.r);
    actors.push({ name: this.dreaming ? 'Dreamer · dreaming' : 'Dreamer · relaxing',
      x: dreamerHome.x - .64, y: dreamerHome.y + .48, color: '#8f75aa', light: '#e4cbed',
      phase: 1.4, moving: false, status: this.dreaming ? 'working' : 'idle' });
    const helpdeskHome = axialToWorld(STATIONS.helpdesk.q, STATIONS.helpdesk.r);
    const helping = this.boardHelpRequests.some(request => request.helperStatus === 'working');
    actors.push({ name: helping ? 'Helpdesk agent · helping' : 'Helpdesk agent · available',
      x: helpdeskHome.x + .64, y: helpdeskHome.y + .45, color: '#5c8991', light: '#c4e4e1',
      phase: .8, moving: false, status: helping ? 'working' : 'idle' });
    for (const [index, agent] of this.boardAgents.entries()) {
      const resting = ['relaxing', 'sleeping'].includes(agent.status);
      const assigned = this.boardJobs.find(job => job.id === agent.jobId);
      const isLead = agent.id === TEAM_AGENT_ID;
      const run = assigned?.teamRun;
      const nextStage = run?.status === 'running' ? TEAM_STAGES.find(stage => !run[stage]) : null;
      if (isLead) {
        for (const specialist of specialists) {
          const site = STATIONS[specialist.station];
          const center = axialToWorld(site.q, site.r);
          const working = nextStage === specialist.stage;
          const duty = working ? 'working' : 'standby';
          actors.push({ ...specialist, name: specialist.name + ' · ' + duty,
            x: center.x + specialist.offset, y: center.y + .58, phase: 0, moving: false, status: working ? 'working' : 'idle' });
        }
      }
      const location = resting ? 'spa' : assigned?.status === 'testing' ? 'test' : assigned?.status === 'review' ? 'review' : 'workbench';
      const station = STATIONS[location];
      const home = axialToWorld(station.q, station.r);
      const angle = this.clock * .3 + index;
      const x = home.x + .76 * Math.cos(angle), y = home.y + .76 * Math.sin(angle);
      const valid = canOccupy(this.renderer.world, this.player.obstacles, x, y);
      const working = agent.status === 'busy' && (run?.status === 'running' || (run?.status === 'submitted' && ['testing', 'review'].includes(assigned?.status)) || (!isLead && assigned?.status === 'in_progress'));
      const activity = working ? 'working' : assigned?.status === 'testing' ? 'awaiting test' : assigned?.status === 'review' ? 'awaiting review' : agent.status;
      actors.push({ name: `${agent.name} · ${activity}`, x: valid && agent.status === 'idle' ? x : home.x + .72, y: valid && agent.status === 'idle' ? y : home.y + .25, color: isLead ? '#675c8b' : '#829bab', light: isLead ? '#d7c3ec' : '#c0d7df', phase: index, moving: this.renderer.motion && agent.status === 'idle', status: working ? 'working' : agent.status });
    }
    return actors;
  }

  enter() {
    this.onEnter();
    this.active = true;
    this.paused = false;
    document.body.classList.add('playing');
    $('#play-toggle').textContent = 'Island view';
    $('#play-toggle').setAttribute('aria-pressed', 'true');
    $('#play-toggle').title = 'Return to the island overview (V)';
    $('#player-hud').hidden = false;
    this.canvas.setAttribute('aria-label', 'First-person island. WASD to walk, Shift to run, Space to jump, arrow keys to look, E to visit a nearby station. V returns to the overview.');
    this.resume();
    this.renderer.invalidate();
  }

  exit() {
    this.active = false;
    this.clearInput();
    this.player.z = 0;
    this.player.velocityZ = 0;
    this.releaseMouse();
    document.body.classList.remove('playing');
    $('#play-toggle').textContent = 'Enter island';
    $('#play-toggle').setAttribute('aria-pressed', 'false');
    $('#play-toggle').title = 'Explore in first person (V)';
    $('#player-hud').hidden = true;
    this.canvas.setAttribute('aria-label', 'A miniature island made of grassy hexagons. Drag to pan, scroll to zoom, or enter the island to walk in first person.');
    this.renderer.setTool(this.renderer.tool);
    this.renderer.invalidate();
  }

  releaseMouse() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  pause() {
    if (!this.active) return;
    this.paused = true;
    this.clearInput();
    this.releaseMouse();
    this.updateHint();
  }

  resume() {
    if (!this.active || document.querySelector('dialog[open]')) return;
    this.paused = false;
    this.canvas.focus({ preventScroll: true });
    this.canvas.style.cursor = 'crosshair';
    if (window.matchMedia('(pointer: fine)').matches && document.pointerLockElement !== this.canvas) {
      try {
        const request = this.canvas.requestPointerLock?.();
        request?.catch(() => this.updateHint());
      } catch { /* Drag-to-look and keyboard controls remain available. */ }
    }
    this.updateHint();
    this.renderer.invalidate();
  }

  clearInput() {
    this.keys.clear(); this.touchKeys.clear(); this.lookDrag = null; this.touchSprint = false;
    this.player.moving = false;
    $('#player-sprint').setAttribute('aria-pressed', 'false');
  }

  updateHint() {
    $('#player-resume').hidden = !this.paused;
    $('#player-resume span').textContent = window.matchMedia('(pointer: coarse)').matches ? 'Tap to continue. Drag the scenery to look.' : 'Click to capture the mouse, or drag to look';
    $('#player-look-hint').textContent = this.paused ? 'Mouse released. Resume when you’re ready.' : document.pointerLockElement === this.canvas ? 'Mouse to look · Esc releases mouse · V island view' : 'Drag to look · Arrow keys to look · V island view';
  }

  interact() {
    const tile = this.player.nearbyStation();
    if (tile) { this.pause(); this.openStation(tile.station); }
  }

  update(seconds) {
    if (this.renderer.motion) this.clock += Math.min(seconds, .05);
    if (!this.active) return;
    const paused = this.paused || !!document.querySelector('dialog[open]') || !$('#help-panel').hidden;
    if (!paused) {
      const down = code => this.keys.has(code) || [...this.touchKeys.values()].includes(code);
      this.player.update(seconds, {
        forward: Number(down('KeyW')) - Number(down('KeyS')),
        right: Number(down('KeyD')) - Number(down('KeyA')),
        turn: Number(down('ArrowRight')) - Number(down('ArrowLeft')),
        look: Number(down('ArrowDown')) - Number(down('ArrowUp')),
        sprint: down('ShiftLeft') || down('ShiftRight') || this.touchSprint,
      });
    }
    const tile = tileAt(this.renderer.world, this.player.x, this.player.y);
    const location = tile ? `Hex ${String(tile.number).padStart(2, '0')} · ${tile.terrain === 'grove' ? 'Woodland' : tile.terrain === 'earth' ? 'Earth' : tile.terrain === 'wildflowers' ? 'Wildflowers' : 'Meadow'}` : 'The island';
    if ($('#player-location').textContent !== location) $('#player-location').textContent = location;
    const nearby = this.player.nearbyStation();
    const prompt = nearby ? `Visit ${STATIONS[nearby.station].name} · E` : '';
    $('#player-interact').hidden = !nearby || paused;
    if ($('#player-interact').textContent !== prompt) $('#player-interact').textContent = prompt;
  }

  bindEvents() {
    this.listen($('#play-toggle'), 'click', () => this.active ? this.exit() : this.enter());
    this.listen($('#player-resume'), 'click', () => this.resume());
    this.listen($('#player-interact'), 'click', () => this.interact());
    this.listen(document, 'keydown', event => {
      if (editing(event.target) || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
      if (event.code === 'KeyV' && !event.repeat) { event.preventDefault(); this.active ? this.exit() : this.enter(); return; }
      if (!this.active) return;
      if (event.code === 'Escape') { this.pause(); return; }
      if (MOVEMENT.has(event.code)) event.preventDefault();
      if (this.paused || !$('#help-panel').hidden) return;
      this.keys.add(event.code);
      if (event.code === 'Space' && !event.repeat) this.player.jump();
      if (event.code === 'KeyE' && !event.repeat) this.interact();
    });
    this.listen(document, 'keyup', event => this.keys.delete(event.code));
    this.listen(window, 'blur', () => this.pause());
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.pause(); });
    this.listen(document, 'pointerlockchange', () => {
      if (this.active && document.pointerLockElement !== this.canvas) { this.paused = true; this.clearInput(); }
      this.updateHint();
    });
    this.listen(document, 'pointerlockerror', () => this.updateHint());
    this.listen(document, 'mousemove', event => {
      if (this.active && !this.paused && document.pointerLockElement === this.canvas) this.player.look(event.movementX * .0025, event.movementY * .0025);
    });
    this.listen(this.canvas, 'pointerdown', event => {
      if (!this.active || event.button !== 0) return;
      if (this.paused) this.resume();
      if (document.pointerLockElement !== this.canvas) {
        this.lookDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        this.canvas.setPointerCapture(event.pointerId);
      }
    });
    this.listen(document, 'pointermove', event => {
      if (!this.active || this.paused || document.querySelector('dialog[open]') || !$('#help-panel').hidden) return;
      let dx = 0, dy = 0;
      if (document.pointerLockElement === this.canvas) return;
      if (this.lookDrag?.id === event.pointerId) {
        dx = event.clientX - this.lookDrag.x; dy = event.clientY - this.lookDrag.y;
        this.lookDrag.x = event.clientX; this.lookDrag.y = event.clientY;
      }
      this.player.look(dx * .0025, dy * .0025);
    });
    const finishLook = event => { if (this.lookDrag?.id === event.pointerId) this.lookDrag = null; };
    this.listen(this.canvas, 'pointerup', finishLook);
    this.listen(this.canvas, 'pointercancel', finishLook);
    document.querySelectorAll('[data-walk]').forEach(button => {
      this.listen(button, 'pointerdown', event => {
        event.preventDefault();
        if (!this.active || this.paused) return;
        button.setPointerCapture(event.pointerId);
        this.touchKeys.set(event.pointerId, button.dataset.walk);
      });
      const release = event => this.touchKeys.delete(event.pointerId);
      this.listen(button, 'pointerup', release); this.listen(button, 'pointercancel', release); this.listen(button, 'lostpointercapture', release);
    });
    this.listen($('#player-jump'), 'click', () => { if (!this.paused) this.player.jump(); });
    this.listen($('#player-sprint'), 'click', () => {
      this.touchSprint = !this.touchSprint;
      $('#player-sprint').setAttribute('aria-pressed', String(this.touchSprint));
    });
  }

  destroy() {
    this.releaseMouse();
    this.listeners.forEach(dispose => dispose());
    this.renderer.explorer = null;
  }
}
