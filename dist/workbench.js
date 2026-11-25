import {
  registerAgent, postJob, claimJob, submitJobForTesting, resumeJob, releaseJob, summarizeJobs,
} from './jobs.js';

const PREVIEW_AGENT = 'preview-agent';
const $ = selector => document.querySelector(selector);
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** Browser-local station UI; job rules remain independent of DOM and rendering. */
export function initWorkbench({ renderer, onBeforeOpen, store } = {}) {
  let board = store.getBoard();
  let filter = 'available';
  let submitting = false;
  const panel = $('#workbench-panel');

  function feedback(message, error = false) {
    $('#board-feedback').textContent = message;
    $('#board-feedback').classList.toggle('error', error);
  }

  function setFilter(next) { filter = next; render(); }

  async function mutate(action, successMessage, nextFilter) {
    const result = await store.mutate(current => { board = current; return action(); });
    if (!result.ok) { feedback(result.message, true); render(); return result; }
    if (nextFilter) filter = nextFilter;
    render();
    feedback(successMessage);
    return result;
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
      const resting = preview && ['relaxing', 'sleeping'].includes(preview.status);
      footer.append(element('span', 'job-waiting', preview?.status === 'busy' ? 'Preview agent is busy' : resting ? 'Preview agent is resting at the spa' : 'Ready for an available agent'));
      if (preview) {
        const claim = element('button', 'secondary-button claim-job', 'Pick up job');
        claim.disabled = preview.status !== 'idle';
        if (claim.disabled) claim.title = resting ? 'Wake the preview agent at the spa first.' : 'Finish or return the current job first.';
        claim.addEventListener('click', () => mutate(() => claimJob(board, job.id, preview.id), 'The preview agent picked up this job.', 'in_progress'));
        footer.append(claim);
      }
    } else {
      const owner = board.agents.find(agent => agent.id === job.claimedBy);
      const stage = {
        in_progress: 'Working on it', changes_requested: 'Changes requested',
        testing: 'At the Test station', review: 'At the Review station', completed: 'Approved',
      }[job.status] || job.status;
      footer.append(element('span', 'job-owner', `${stage} · ${owner?.name || 'Agent'}`));
      if (['in_progress', 'changes_requested'].includes(job.status) && job.claimedBy === PREVIEW_AGENT) {
        const actions = element('div', 'job-card-actions');
        const release = element('button', 'job-return', 'Return');
        release.title = 'Return this job to the available board';
        release.addEventListener('click', () => mutate(() => releaseJob(board, job.id, PREVIEW_AGENT), 'Returned to the board, ready for another pickup.', 'available'));
        const advance = element('button', 'secondary-button complete-job', job.status === 'changes_requested' ? 'Resume work' : 'Send to tests');
        advance.title = job.status === 'changes_requested' ? 'Resume work after feedback' : 'Submit this job to the Test station';
        advance.addEventListener('click', () => job.status === 'changes_requested'
          ? mutate(() => resumeJob(board, job.id, PREVIEW_AGENT), 'Work resumed. You can send it to tests when ready.', 'in_progress')
          : mutate(() => submitJobForTesting(board, job.id, PREVIEW_AGENT), 'Sent to the Test station for a check.', 'in_progress'));
        actions.append(release, advance);
        footer.append(actions);
      }
    }
    if (job.status === 'changes_requested') {
      const lastTest = job.testRuns?.at(-1);
      const lastReview = job.reviews?.at(-1);
      const latest = [lastTest?.passed === false ? lastTest : null, lastReview?.approved === false ? lastReview : null]
        .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const note = latest?.notes;
      if (note) card.append(element('p', 'job-description', `Feedback: ${note}`));
    }
    card.append(footer);
    return card;
  }

  function render() {
    board = store.getBoard();
    const counts = summarizeJobs(board);
    const preview = board.agents.find(agent => agent.id === PREVIEW_AGENT);
    $('#available-count').textContent = counts.available;
    const working = board.jobs.filter(job => ['in_progress', 'changes_requested'].includes(job.status)).length;
    $('#progress-count').textContent = working;
    $('#tab-available').textContent = counts.available;
    $('#tab-progress').textContent = working;
    $('#tab-done').textContent = counts.completed;
    $('#station-job-count').textContent = counts.available;
    $('#open-workbench').setAttribute('aria-label', `Open workbench on Hex 01, ${counts.available} available jobs`);
    renderer?.setWorkbenchState(counts);
    document.querySelectorAll('[data-job-filter]').forEach(button => {
      const active = button.dataset.jobFilter === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#preview-agent-status').textContent = {
      busy: 'Busy · one job at a time', relaxing: 'Relaxing at the spa · wake to pick up work',
      sleeping: 'Sleeping at the spa · wake to pick up work', idle: 'Available · ready to pick up a job',
    }[preview?.status] || 'Ready to try a job';
    $('#enable-preview').textContent = preview ? 'Enabled' : 'Enable';
    $('#enable-preview').disabled = !!preview;
    $('#workbench-panel .preview-agent').classList.toggle('is-busy', preview?.status === 'busy');
    $('#storage-status').textContent = store.storageAvailable
      ? 'Saved in this browser. Real agents are not connected yet.'
      : 'Changes last for this visit; browser storage is unavailable.';

    const jobs = board.jobs.filter(job => filter === 'in_progress'
      ? ['in_progress', 'changes_requested'].includes(job.status) : job.status === filter);
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
  const unsubscribe = store.subscribe(render);
  render();
  return { open, destroy: unsubscribe };
}
