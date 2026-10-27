import {
  createJobBoard, registerAgent, postJob, claimJob, completeJob, releaseJob,
  summarizeJobs, serializeJobBoard, restoreJobBoard,
} from './jobs.js';

const STORAGE_KEY = 'agent-island.workbench.v1';
const PREVIEW_AGENT = 'preview-agent';
const $ = selector => document.querySelector(selector);
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** Browser-local station UI; job rules remain independent of DOM and rendering. */
export function initWorkbench({ renderer, onBeforeOpen } = {}) {
  let board = createJobBoard();
  let storageAvailable = true;
  let filter = 'available';
  let submitting = false;
  const panel = $('#workbench-panel');
  try { board = restoreJobBoard(localStorage.getItem(STORAGE_KEY)); }
  catch { storageAvailable = false; }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, serializeJobBoard(board)); storageAvailable = true; }
    catch { storageAvailable = false; }
  }

  function feedback(message, error = false) {
    $('#board-feedback').textContent = message;
    $('#board-feedback').classList.toggle('error', error);
  }

  function setFilter(next) { filter = next; render(); }

  function performMutation(action, successMessage, nextFilter) {
    if (storageAvailable) {
      try { board = restoreJobBoard(localStorage.getItem(STORAGE_KEY)); }
      catch { storageAvailable = false; }
    }
    const result = action();
    if (!result.ok) { feedback(result.message, true); render(); return result; }
    if (nextFilter) filter = nextFilter;
    save();
    render();
    feedback(successMessage);
    return result;
  }

  function mutate(action, successMessage, nextFilter) {
    // Tabs of this same local board share a lock; a stale tab cannot double-claim a job.
    if (navigator.locks?.request) {
      return navigator.locks.request(STORAGE_KEY, () => performMutation(action, successMessage, nextFilter));
    }
    return Promise.resolve(performMutation(action, successMessage, nextFilter));
  }

  function renderJob(job, preview) {
    const card = element('article', `job-card priority-${job.priority}`);
    card.dataset.jobId = job.id;
    const meta = element('div', 'job-card-meta');
    meta.append(element('span', 'job-priority', `${job.priority[0].toUpperCase()}${job.priority.slice(1)} priority`));
    meta.append(element('span', 'job-date', new Date(job.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
    card.append(meta, element('h3', 'job-title', job.title));
    if (job.description) card.append(element('p', 'job-description', job.description));
    const footer = element('div', 'job-card-footer');
    if (job.status === 'available') {
      footer.append(element('span', 'job-waiting', preview?.status === 'busy' ? 'Preview agent is busy' : 'Ready for an available agent'));
      if (preview) {
        const claim = element('button', 'secondary-button claim-job', 'Pick up job');
        claim.disabled = preview.status !== 'idle';
        if (claim.disabled) claim.title = 'Finish or return the current job first.';
        claim.addEventListener('click', () => mutate(() => claimJob(board, job.id, preview.id), 'The preview agent picked up this job.', 'in_progress'));
        footer.append(claim);
      }
    } else {
      const owner = board.agents.find(agent => agent.id === job.claimedBy);
      footer.append(element('span', 'job-owner', `${job.status === 'completed' ? '✓ Finished by' : 'Working on it ·'} ${owner?.name || 'Agent'}`));
      if (job.status === 'in_progress' && job.claimedBy === PREVIEW_AGENT) {
        const actions = element('div', 'job-card-actions');
        const release = element('button', 'job-return', 'Return');
        release.title = 'Return this job to the available board';
        release.addEventListener('click', () => mutate(() => releaseJob(board, job.id, PREVIEW_AGENT), 'Returned to the board, ready for another pickup.', 'available'));
        const complete = element('button', 'secondary-button complete-job', 'Mark done');
        complete.title = 'Complete the preview assignment';
        complete.addEventListener('click', () => mutate(() => completeJob(board, job.id, PREVIEW_AGENT), 'Preview complete. The agent is available again.', 'completed'));
        actions.append(release, complete);
        footer.append(actions);
      }
    }
    card.append(footer);
    return card;
  }

  function render() {
    const counts = summarizeJobs(board);
    const preview = board.agents.find(agent => agent.id === PREVIEW_AGENT);
    $('#available-count').textContent = counts.available;
    $('#progress-count').textContent = counts.inProgress;
    $('#tab-available').textContent = counts.available;
    $('#tab-progress').textContent = counts.inProgress;
    $('#tab-done').textContent = counts.completed;
    $('#station-job-count').textContent = counts.available;
    $('#open-workbench').setAttribute('aria-label', `Open workbench on Hex 01, ${counts.available} available jobs`);
    renderer?.setWorkbenchState(counts);
    document.querySelectorAll('[data-job-filter]').forEach(button => {
      const active = button.dataset.jobFilter === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#preview-agent-status').textContent = preview?.status === 'busy' ? 'Busy · one job at a time' : preview ? 'Available · ready to pick up a job' : 'Ready to try a job';
    $('#enable-preview').textContent = preview ? 'Enabled' : 'Enable';
    $('#enable-preview').disabled = !!preview;
    $('.preview-agent').classList.toggle('is-busy', preview?.status === 'busy');
    $('#storage-status').textContent = storageAvailable
      ? 'Saved in this browser. Real agents are not connected yet.'
      : 'Changes last for this visit; browser storage is unavailable.';

    const jobs = board.jobs.filter(job => job.status === filter);
    const priority = { high: 0, normal: 1, low: 2 };
    jobs.sort((a, b) => filter === 'available' ? priority[a.priority] - priority[b.priority] || b.createdAt.localeCompare(a.createdAt) : b.createdAt.localeCompare(a.createdAt));
    const list = $('#jobs-list');
    list.replaceChildren();
    if (!jobs.length) {
      const empty = element('div', 'empty-board');
      const artwork = element('div', `empty-board-art ${filter === 'completed' ? 'done-art' : ''}`);
      artwork.append(element('span', 'paper-note note-one'), element('span', 'paper-note note-two'), element('span', 'paper-note note-three'));
      empty.append(artwork);
      empty.append(element('h3', '', { available: 'An idea belongs here.', in_progress: 'A moment between jobs.', completed: 'Good things take a little work.' }[filter]));
      empty.append(element('p', '', { available: 'Pin the first job to the board. It will be here when an agent is ready.', in_progress: 'Jobs appear here after an available agent picks one up.', completed: 'Finished jobs will collect here, one little achievement at a time.' }[filter]));
      if (filter === 'available') {
        const first = element('button', 'secondary-button', 'Post the first job ↗');
        first.addEventListener('click', () => showForm(true));
        empty.append(first);
      }
      list.append(empty);
    } else jobs.forEach(job => list.append(renderJob(job, preview)));
  }

  function showForm(show) {
    $('#job-form').hidden = !show;
    $('#new-job-button').hidden = show;
    if (show) { $('#job-title').focus(); $('#job-form').scrollIntoView({ block: 'nearest' }); }
    else $('#new-job-button').focus();
  }

  function open() {
    onBeforeOpen?.();
    render();
    if (!panel.open) panel.showModal();
  }

  $('#open-workbench').addEventListener('click', open);
  $('#close-workbench').addEventListener('click', () => panel.close());
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const bounds = panel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
  });
  $('#new-job-button').addEventListener('click', () => showForm(true));
  $('#cancel-job').addEventListener('click', () => { $('#job-form').reset(); showForm(false); });
  $('#job-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const input = {
      title: $('#job-title').value,
      description: $('#job-description').value,
      priority: $('#job-priority').value,
    };
    submitting = true;
    const submitButton = $('#job-form button[type="submit"]');
    submitButton.disabled = true;
    try {
      const result = await mutate(() => postJob(board, input), 'Pinned to the board, ready to be picked up.', 'available');
      if (result.ok) { $('#job-form').reset(); showForm(false); }
    } finally { submitting = false; submitButton.disabled = false; }
  });
  document.querySelectorAll('[data-job-filter]').forEach(button => button.addEventListener('click', () => { feedback(''); setFilter(button.dataset.jobFilter); }));
  $('#enable-preview').addEventListener('click', () => mutate(() => registerAgent(board, { id: PREVIEW_AGENT, name: 'Preview agent' }), 'Preview enabled. Pick up any available job to try the handoff.'));
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    board = restoreJobBoard(event.newValue);
    render();
    if (panel.open) feedback('The board was updated in another tab.');
  });
  render();
  return { open };
}
