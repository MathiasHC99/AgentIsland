import { registerAgent, setAgentRest, wakeAgent, postHelpRequest, resolveHelpRequest, summarizeHelpdesk } from './jobs.js';

const $ = selector => document.querySelector(selector);
const PREVIEW_AGENT = 'preview-agent';
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};

/** The helpdesk and spa share the workbench's local agent identities and state. */
export function initStations({ store, renderer, onBeforeOpen, openWorkbench }) {
  let helpFilter = 'open';
  let submitting = false;

  function feedback(station, message, error = false) {
    const target = $(`#${station === 'helpdesk' ? 'help' : 'spa'}-feedback`);
    target.textContent = message;
    target.classList.toggle('error', error);
  }

  async function mutate(station, action, success) {
    const result = await store.mutate(action);
    feedback(station, result.ok ? success : result.message, !result.ok);
    return result;
  }

  function renderHelpdesk(board) {
    const counts = summarizeHelpdesk(board);
    $('#helpdesk-count').textContent = counts.open;
    $('#open-help-count').textContent = counts.open;
    $('#resolved-help-count').textContent = counts.resolved;
    $('#help-tab-open').textContent = counts.open;
    $('#help-tab-resolved').textContent = counts.resolved;
    $('#open-helpdesk').setAttribute('aria-label', `Open helpdesk, ${counts.open} open questions`);
    renderer.setHelpdeskState(counts);
    document.querySelectorAll('[data-help-filter]').forEach(button => {
      const active = button.dataset.helpFilter === helpFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const requests = board.helpRequests.filter(request => request.status === helpFilter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const list = $('#help-list');
    list.replaceChildren();
    if (!requests.length) {
      const empty = element('div', 'empty-board help-empty');
      empty.append(element('span', 'help-empty-icon', helpFilter === 'open' ? '?' : '✓'));
      empty.append(element('h3', '', helpFilter === 'open' ? 'A little help goes a long way.' : 'One less thing to wonder about.'));
      empty.append(element('p', '', helpFilter === 'open' ? 'Leave a question for the island. A shared thought is a good place to begin.' : 'Questions you mark as resolved will find their home here.'));
      if (helpFilter === 'open') {
        const ask = element('button', 'secondary-button', 'Ask the first question ↗');
        ask.addEventListener('click', () => showForm(true));
        empty.append(ask);
      }
      list.append(empty);
    }
    for (const request of requests) {
      const card = element('article', 'job-card help-card');
      card.dataset.requestId = request.id;
      const meta = element('div', 'job-card-meta');
      meta.append(element('span', 'job-priority', request.status === 'open' ? 'A question for the island' : 'Resolved'));
      meta.append(element('span', 'job-date', new Date(request.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      card.append(meta, element('h3', 'job-title', request.title));
      if (request.details) card.append(element('p', 'job-description', request.details));
      const footer = element('div', 'job-card-footer');
      footer.append(element('span', 'job-owner', `${request.status === 'resolved' ? '✓ Resolved · ' : ''}Asked by ${request.author}`));
      if (request.status === 'open') {
        const resolve = element('button', 'secondary-button resolve-help', 'Mark resolved');
        resolve.addEventListener('click', () => mutate('helpdesk', current => resolveHelpRequest(current, request.id), 'A little clarity. Your question is marked resolved.'));
        footer.append(resolve);
      }
      card.append(footer);
      list.append(card);
    }
  }

  function renderSpa(board) {
    const relaxing = board.agents.filter(agent => agent.status === 'relaxing').length;
    const sleeping = board.agents.filter(agent => agent.status === 'sleeping').length;
    const preview = board.agents.find(agent => agent.id === PREVIEW_AGENT);
    const state = preview?.status || 'absent';
    $('#spa-count').textContent = relaxing + sleeping;
    $('#spa-relaxing-count').textContent = relaxing;
    $('#spa-sleeping-count').textContent = sleeping;
    $('#open-spa').setAttribute('aria-label', `Open spa, ${relaxing + sleeping} resting agents`);
    renderer.setSpaState({ relaxing, sleeping, total: relaxing + sleeping });
    $('#spa-enable-preview').hidden = !!preview;
    $('#spa-actions').hidden = !preview;
    $('#spa-status-badge').textContent = { absent: 'Not visiting', idle: 'Available', busy: 'On a job', relaxing: 'Relaxing', sleeping: 'Sleeping' }[state];
    $('#spa-agent-status').textContent = { absent: 'A quiet corner is waiting', idle: 'Available · ready for a visit', busy: 'Busy · a job needs finishing first', relaxing: 'At the spa · taking a breather', sleeping: 'At the spa · sweet little dreams' }[state];
    $('#spa-visit-description').textContent = {
      absent: 'Try a visit with the same preview agent used at the workbench.',
      idle: 'A job well done deserves a little pause. Choose how to unwind.',
      busy: 'Finish or return the current job at the workbench before taking a break.',
      relaxing: 'There is no hurry here. Wake the agent when it is ready for another job.',
      sleeping: 'Let the world go quiet for a while. Wake the agent before picking up work.',
    }[state];
    $('#spa-scene').dataset.mood = state;
    $('#spa-scene-caption').textContent = { sleeping: 'Sweet little dreams.', relaxing: 'A well-earned little pause.' }[state] || 'Somewhere to just be.';
    $('#spa-relax').disabled = state === 'busy' || state === 'relaxing';
    $('#spa-sleep').disabled = state === 'busy' || state === 'sleeping';
    $('#spa-wake').disabled = !['relaxing', 'sleeping'].includes(state);
    $('#spa-relax').setAttribute('aria-pressed', String(state === 'relaxing'));
    $('#spa-sleep').setAttribute('aria-pressed', String(state === 'sleeping'));
    $('#spa-visit-workbench').hidden = !preview;
  }

  function render() {
    const board = store.getBoard();
    renderHelpdesk(board);
    renderSpa(board);
    document.querySelectorAll('[data-station-storage]').forEach(node => {
      node.textContent = store.storageAvailable ? 'Saved in this browser. Real agents are not connected yet.' : 'Changes last for this visit; browser storage is unavailable.';
    });
  }

  function showForm(show) {
    $('#help-form').hidden = !show;
    $('#new-help-button').hidden = show;
    if (show) { $('#help-title').focus(); $('#help-form').scrollIntoView({ block: 'nearest' }); }
    else $('#new-help-button').focus();
  }

  function open(station) {
    if (!['helpdesk', 'spa'].includes(station)) return;
    onBeforeOpen?.();
    render();
    $(`#${station}-panel`).showModal();
  }

  for (const station of ['helpdesk', 'spa']) {
    $(`#open-${station}`).addEventListener('click', () => open(station));
    $(`#close-${station}`).addEventListener('click', () => $(`#${station}-panel`).close());
    $(`#${station}-panel`).addEventListener('click', event => {
      const panel = event.currentTarget;
      if (event.target !== panel) return;
      const bounds = panel.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
    });
  }
  $('#new-help-button').addEventListener('click', () => showForm(true));
  $('#cancel-help').addEventListener('click', () => { $('#help-form').reset(); showForm(false); });
  document.querySelectorAll('[data-help-filter]').forEach(button => button.addEventListener('click', () => {
    helpFilter = button.dataset.helpFilter;
    feedback('helpdesk', '');
    render();
  }));
  $('#help-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const input = { title: $('#help-title').value, details: $('#help-details').value, author: 'You' };
    submitting = true;
    const submitButton = $('#help-form button[type="submit"]');
    submitButton.disabled = true;
    try {
      const result = await mutate('helpdesk', current => postHelpRequest(current, input), 'Your question is on the board. A good place to start.');
      if (result.ok) { helpFilter = 'open'; $('#help-form').reset(); showForm(false); render(); }
    } finally { submitting = false; submitButton.disabled = false; }
  });
  $('#spa-enable-preview').addEventListener('click', () => mutate('spa', current => registerAgent(current, { id: PREVIEW_AGENT, name: 'Preview agent' }), 'The preview agent is ready for a little break.'));
  $('#spa-relax').addEventListener('click', () => mutate('spa', current => setAgentRest(current, PREVIEW_AGENT, 'relaxing'), 'Feet up. The preview agent is taking a breather.'));
  $('#spa-sleep').addEventListener('click', () => mutate('spa', current => setAgentRest(current, PREVIEW_AGENT, 'sleeping'), 'Sweet dreams. Jobs can wait until the agent wakes.'));
  $('#spa-wake').addEventListener('click', () => mutate('spa', current => wakeAgent(current, PREVIEW_AGENT), 'Rested and ready. The preview agent can pick up work again.'));
  $('#spa-visit-workbench').addEventListener('click', openWorkbench);
  const unsubscribe = store.subscribe(render);
  render();
  return { open, destroy: unsubscribe };
}
