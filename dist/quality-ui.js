import { recordTestResult, recordReviewDecision } from './jobs.js';

const $ = selector => document.querySelector(selector);
const node = (tag, className = '', content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};
const stamp = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Manual preview of the shared job's test and review gates. */
export function initQualityStations({ renderer, store, onBeforeOpen }) {
  const drafts = new Map();

  function feedback(station, message, error = false) {
    const target = $(`#${station}-feedback`);
    target.textContent = message;
    target.classList.toggle('error', error);
  }

  async function decide(station, job, accepted, textarea) {
    const notes = textarea.value.trim();
    if (!accepted && !notes) {
      feedback(station, station === 'test' ? 'Add a note explaining what failed.' : 'Add feedback explaining the changes needed.', true);
      textarea.focus();
      return;
    }
    const key = `${station}:${job.id}`;
    const buttons = textarea.closest('.quality-form').querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      const result = await store.mutate(board => station === 'test'
        ? recordTestResult(board, job.id, { passed: accepted, notes })
        : recordReviewDecision(board, job.id, { approved: accepted, notes }));
      if (result?.ok) {
        drafts.delete(key);
        feedback(station, station === 'test'
          ? accepted ? 'Test passed. The job is ready for review.' : 'Test failed. The job needs changes.'
          : accepted ? 'Review approved. The job is complete.' : 'Changes requested. The job is back with its owner.');
        render();
      } else feedback(station, result?.message || 'This job could not be updated.', true);
    } catch {
      feedback(station, 'This result could not be saved. Please try again.', true);
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function latestEntry(job, station) {
    const list = station === 'test' ? job.testRuns : job.reviews;
    return list?.at(-1) || null;
  }

  function entryLabel(station, entry) {
    if (station === 'test') return entry.passed ? 'Passed test' : 'Failed test';
    return entry.approved ? 'Approved review' : 'Changes requested';
  }

  function renderEntry(station, entry, className = 'quality-entry') {
    const wrapper = node('div', className);
    wrapper.append(node('strong', '', `${entryLabel(station, entry)} · ${stamp(entry.createdAt)}`));
    if (entry.notes) wrapper.append(node('p', '', entry.notes));
    return wrapper;
  }

  function renderCard(station, job, pending) {
    const card = node('article', `job-card quality-card priority-${job.priority}`);
    const meta = node('div', 'job-card-meta');
    meta.append(node('span', 'job-priority', `${job.priority[0].toUpperCase()}${job.priority.slice(1)} priority`));
    meta.append(node('span', 'job-date', `Posted ${stamp(job.createdAt)}`));
    card.append(meta, node('h3', 'job-title', job.title));
    if (job.description) card.append(node('p', 'job-description', job.description));
    if (station === 'review') {
      const run = latestEntry(job, 'test');
      if (run) {
        const evidence = node('div', 'quality-evidence');
        evidence.append(node('strong', '', `Test ${run.passed ? 'passed' : 'failed'} · ${stamp(run.createdAt)}`));
        evidence.append(node('span', '', run.notes || 'No test notes were added.'));
        card.append(evidence);
      }
    }
    if (pending) {
      const earlier = latestEntry(job, station);
      if (earlier) card.append(renderEntry(station, earlier));
      const form = node('div', 'quality-form');
      const label = node('label', '', station === 'test' ? 'What did you check? (required for a failure)' : 'Review notes (required for changes)');
      const textarea = node('textarea');
      textarea.id = `${station}-notes-${job.id}`;
      textarea.maxLength = 2000;
      textarea.rows = 3;
      textarea.placeholder = station === 'test' ? 'Test steps, result, or evidence…' : 'What is ready, or what needs changing…';
      textarea.value = drafts.get(`${station}:${job.id}`) || '';
      textarea.addEventListener('input', () => drafts.set(`${station}:${job.id}`, textarea.value));
      label.htmlFor = textarea.id;
      const actions = node('div', 'quality-actions');
      const accept = node('button', 'primary-button', station === 'test' ? 'Pass test' : 'Approve');
      const reject = node('button', 'secondary-button', station === 'test' ? 'Fail test' : 'Request changes');
      accept.type = reject.type = 'button';
      accept.addEventListener('click', () => decide(station, job, true, textarea));
      reject.addEventListener('click', () => decide(station, job, false, textarea));
      actions.append(accept, reject);
      form.append(label, textarea, actions);
      card.append(form);
    } else {
      const entry = latestEntry(job, station);
      if (entry) card.append(renderEntry(station, entry));
      card.append(node('div', 'quality-outcome', `Current job state: ${job.status.replaceAll('_', ' ')}`));
    }
    return card;
  }

  function renderStation(station, board) {
    const status = station === 'test' ? 'testing' : 'review';
    const pending = board.jobs.filter(job => job.status === status);
    const recent = board.jobs.filter(job => job.status !== status && (station === 'test' ? job.testRuns : job.reviews)?.length)
      .sort((a, b) => latestEntry(b, station).createdAt.localeCompare(latestEntry(a, station).createdAt)).slice(0, 6);
    $(`#${station}-count`).textContent = pending.length;
    $(`#${station}-pending-count`).textContent = pending.length;
    $(`#open-${station}`).setAttribute('aria-label', `Open ${station} station, ${pending.length} ${station === 'test' ? 'awaiting tests' : 'awaiting review'}`);
    if (station === 'test') renderer?.setTestState({ pending: pending.length });
    else renderer?.setReviewState({ pending: pending.length });
    const list = $(`#${station}-list`);
    list.replaceChildren();
    list.append(node('h3', 'quality-section-heading', pending.length ? 'Ready now' : 'Nothing waiting'));
    if (pending.length) pending.forEach(job => list.append(renderCard(station, job, true)));
    else {
      const empty = node('div', 'quality-empty');
      empty.append(node('strong', '', station === 'test' ? 'Tests begin with a submission.' : 'Reviews begin with a passing test.'));
      empty.append(node('p', '', station === 'test' ? 'Pick up a job at the workbench and submit it here when the work is ready.' : 'A tested job will appear here for a final decision.'));
      const openWorkbench = node('button', 'secondary-button', 'Visit the workbench');
      openWorkbench.addEventListener('click', () => $('#open-workbench').click());
      empty.append(openWorkbench);
      list.append(empty);
    }
    if (recent.length) {
      list.append(node('h3', 'quality-section-heading history', 'Recent decisions'));
      const history = node('div', 'quality-history');
      recent.forEach(job => history.append(renderCard(station, job, false)));
      list.append(history);
    }
  }

  function render() {
    const board = store.getBoard();
    renderStation('test', board);
    renderStation('review', board);
    document.querySelectorAll('[data-quality-storage]').forEach(element => {
      element.textContent = store.storageAvailable
        ? 'Saved in this browser. Real agents are not connected yet.'
        : 'Changes last for this visit; browser storage is unavailable.';
    });
  }

  function open(station) {
    if (station !== 'test' && station !== 'review') return;
    onBeforeOpen?.();
    render();
    $(`#${station}-panel`).showModal();
  }

  for (const station of ['test', 'review']) {
    const panel = $(`#${station}-panel`);
    $(`#open-${station}`).addEventListener('click', () => open(station));
    $(`#close-${station}`).addEventListener('click', () => panel.close());
    panel.addEventListener('click', event => {
      if (event.target !== panel) return;
      const bounds = panel.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
    });
  }
  const unsubscribe = store.subscribe(render);
  render();
  return { open, destroy: unsubscribe };
}
