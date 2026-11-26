import {
  registerAgent, postJob, deleteJob, claimJob, submitJobForTesting, resumeJob, releaseJob, summarizeJobs,
  canBrainstorm, saveIdeas, dismissIdea, plantIdea, setDailyIdeas,
} from '../domain/jobs.js';
import { appendTeamOutput, createTeamControls } from './team-ui.js';
import { ideaContext, parseIdeaResponse } from '../domain/idea-garden.js';

const PREVIEW_AGENT = 'preview-agent';
const $ = selector => document.querySelector(selector);
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** Browser-local station UI; job rules remain independent of DOM and rendering. */
export function initWorkbench({ renderer, onBeforeOpen, store, notifyHuman, onDreaming = () => {} } = {}) {
  let board = store.getBoard();
  let filter = 'available';
  let submitting = false;
  let dreaming = false;
  let checkingDreamer = false;
  const expandedDone = new Set();
  const panel = $('#workbench-panel');
  const dreamerModelSelect = $('#dreamer-model');
  const team = createTeamControls({ store, setFilter, feedback, render, notifyHuman });

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
    const done = job.status === 'completed';
    const card = element(done ? 'details' : 'article', `job-card priority-${job.priority}${done ? ' done-job' : ''}`);
    card.dataset.jobId = job.id;
    const meta = element('div', 'job-card-meta');
    meta.append(element('span', 'job-priority', `${job.priority[0].toUpperCase()}${job.priority.slice(1)} priority`));
    meta.append(element('span', 'job-date', new Date(job.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
    const heading = element('h3', 'job-title', job.title);
    if (done) {
      const summary = element('summary', 'done-job-summary');
      summary.append(meta, heading, element('span', 'done-job-hint', 'View result'));
      card.append(summary);
      card.open = expandedDone.has(job.id);
      card.addEventListener('toggle', () => {
        if (card.open) expandedDone.add(job.id);
        else expandedDone.delete(job.id);
      });
    } else card.append(meta, heading);
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
    appendTeamOutput(card, job);
    team.addActions(footer, job, board);
    const remove = element('button', 'job-delete', 'Delete job');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete job: ${job.title}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${job.title}” and its saved result? This cannot be undone.`)) return;
      team.cancel(job.id);
      expandedDone.delete(job.id);
      await mutate(() => deleteJob(board, job.id), 'Job deleted.');
    });
    footer.append(remove);
    card.append(footer);
    return card;
  }

  function renderIdeas() {
    const list = $('#idea-list');
    list.replaceChildren();
    const ideas = board.ideas.filter(idea => idea.status === 'new').slice().reverse();
    $('#daily-ideas').checked = board.dailyIdeas;
    const wait = !canBrainstorm(board);
    const model = selectedDreamerModel();
    const button = $('#brainstorm-ideas');
    button.disabled = dreaming || wait || !model;
    button.textContent = dreaming ? 'Dreaming…' : wait ? 'More ideas tomorrow' : 'Dream up ideas';
    $('#dreamer-status').textContent = dreaming
      ? 'The Dreamer is thinking by the water…' : 'The Dreamer is relaxing by the water, ready when you are.';
    $('#spa-panel').classList.toggle('is-dreaming', dreaming);
    for (const idea of ideas) {
      const card = element('article', 'idea-card');
      card.append(element('h4', '', idea.title), element('p', '', idea.why), element('small', '', `Done when: ${idea.doneWhen}`));
      const actions = element('div', 'idea-actions');
      const plant = element('button', 'secondary-button', 'Turn into job');
      plant.addEventListener('click', async () => {
        const result = await store.mutate(current => plantIdea(current, idea.id));
        if (result.ok) filter = 'available';
        $('#idea-feedback').textContent = result.ok ? 'Idea planted as a job in the Workbench.' : result.message;
      });
      const dismiss = element('button', 'job-return', 'Dismiss');
      dismiss.addEventListener('click', async () => {
        const result = await store.mutate(current => dismissIdea(current, idea.id));
        $('#idea-feedback').textContent = result.ok ? 'Idea dismissed.' : result.message;
      });
      actions.append(plant, dismiss);
      card.append(actions);
      list.append(card);
    }
    if (!ideas.length) list.append(element('p', 'idea-empty', 'No ideas growing yet. Ask the team to dream up a few.'));
  }

  function selectedDreamerModel(localOnly = false) {
    if (dreamerModelSelect.disabled) return null;
    const option = localOnly ? [...dreamerModelSelect.options].find(item => item.dataset.provider === 'ollama')
      : dreamerModelSelect.selectedOptions[0];
    return option?.dataset.provider ? { provider: option.dataset.provider, model: option.dataset.model } : null;
  }

  async function refreshDreamerModels() {
    if (checkingDreamer) return;
    checkingDreamer = true;
    const previous = dreamerModelSelect.value;
    try {
      const response = await fetch('/api/agents/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error();
      const status = await response.json();
      if (!Array.isArray(status.providers)) throw new Error();
      dreamerModelSelect.replaceChildren();
      for (const provider of status.providers) for (const model of provider.models) {
        const option = element('option', '', `${provider.label} · ${model}`);
        option.value = `${provider.id}/${model}`;
        option.dataset.provider = provider.id;
        option.dataset.model = model;
        dreamerModelSelect.append(option);
      }
      if ([...dreamerModelSelect.options].some(option => option.value === previous)) dreamerModelSelect.value = previous;
      dreamerModelSelect.disabled = !dreamerModelSelect.options.length;
      if (!dreamerModelSelect.options.length) $('#idea-feedback').textContent = 'Start Ollama or configure an OpenAI model to let the Dreamer think.';
    } catch {
      dreamerModelSelect.disabled = true;
      $('#idea-feedback').textContent = 'The Dreamer cannot reach the model service. Check the island server.';
    } finally { checkingDreamer = false; renderIdeas(); }
    return !dreamerModelSelect.disabled;
  }

  async function onSpaOpen() {
    const ready = await refreshDreamerModels();
    if (ready && store.getBoard().dailyIdeas && canBrainstorm(store.getBoard())) void brainstorm(true);
  }

  async function brainstorm(auto = false) {
    if (dreaming || !canBrainstorm(store.getBoard())) return;
    const chosen = selectedDreamerModel(auto);
    if (!chosen) {
      $('#idea-feedback').textContent = auto ? 'Daily ideas need a local Ollama model.' : 'Choose an available model first.';
      return;
    }
    dreaming = true;
    onDreaming(true);
    $('#idea-feedback').textContent = 'The Dreamer is thinking of small projects…';
    render();
    try {
      const response = await fetch('/api/agents/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'ideas', title: 'Project ideas for AgentIsland',
          description: ideaContext(store.getBoard()), ...chosen }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.text !== 'string') throw new Error(data.error || 'The Dreamer could not finish.');
      const result = await store.mutate(current => saveIdeas(current, parseIdeaResponse(data.text)));
      if (!result.ok) throw new Error(result.message);
      $('#idea-feedback').textContent = result.ideas.length
        ? `${result.ideas.length} new idea${result.ideas.length === 1 ? '' : 's'} planted in the garden.`
        : 'The team suggested ideas already on the board. Try again tomorrow.';
    } catch (error) {
      $('#idea-feedback').textContent = error.message || 'The Dreamer could not finish.';
    } finally { dreaming = false; onDreaming(false); render(); }
  }

  function render() {
    board = store.getBoard();
    team.update(board);
    renderIdeas();
    const counts = summarizeJobs(board);
    const preview = board.agents.find(agent => agent.id === PREVIEW_AGENT);
    $('#available-count').textContent = counts.available;
    const working = board.jobs.filter(job => !['available', 'completed'].includes(job.status)).length;
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
      ? 'Saved in this browser.'
      : 'Changes last for this visit; browser storage is unavailable.';

    const jobs = board.jobs.filter(job => filter === 'in_progress'
      ? !['available', 'completed'].includes(job.status) : job.status === filter);
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

  async function open() {
    onBeforeOpen?.();
    render();
    if (!panel.open) panel.showModal();
    await team.refresh();
  }

  $('#open-workbench').addEventListener('click', open);
  $('#close-workbench').addEventListener('click', () => panel.close());
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const bounds = panel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
  });
  $('#new-job-button').addEventListener('click', () => showForm(true));
  $('#brainstorm-ideas').addEventListener('click', () => { void brainstorm(); });
  $('#daily-ideas').addEventListener('change', async event => {
    const enabled = event.target.checked;
    const result = await store.mutate(current => setDailyIdeas(current, enabled));
    if (!result.ok) { $('#idea-feedback').textContent = result.message; return; }
    if (enabled) void onSpaOpen();
  });
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
  return { open, onSpaOpen, selectedModel: () => team.selectedModel(), destroy() { unsubscribe(); team.destroy(); } };
}
