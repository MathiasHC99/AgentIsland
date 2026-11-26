import { addTodo, removeTodo, setTodoDone, TODO_LIMITS } from '../domain/jobs.js';

const $ = selector => document.querySelector(selector);

export function parseTodoResponse(text) {
  let value;
  try { value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('The agents returned invalid tasks. Try another model.'); }
  if (!value || !Array.isArray(value.todos) || value.todos.length < 1 || value.todos.length > 3
      || value.todos.some(todo => !todo || typeof todo.title !== 'string' || !todo.title.trim()
        || todo.title.length > TODO_LIMITS.title || typeof todo.details !== 'string'
        || todo.details.length > TODO_LIMITS.details)) {
    throw new Error('The agents did not return one to three complete tasks.');
  }
  return value.todos;
}

export function todoContext(board) {
  const jobs = board.jobs.slice(-10).map(job => `${job.title} (${job.status})`).join('; ');
  const issues = board.helpRequests.filter(item => item.status === 'open').slice(-5)
    .map(item => `${item.title}: ${item.details.slice(0, 120)}`).join('; ');
  const tasks = board.todos.filter(item => !item.hidden && !item.done).slice(-15).map(item => item.title).join('; ');
  return `Jobs: ${jobs || 'none'}. Open Helpdesk issues: ${issues || 'none'}. Existing tasks: ${tasks || 'none'}. Suggest small next actions without duplicates.`.slice(0, 2000);
}

export function initNoticeboard({ store, onBeforeOpen, getModel }) {
  const panel = $('#noticeboard-panel');
  const list = $('#todo-list');
  let asking = false;

  function taskCard(todo) {
    const row = document.createElement('article');
    row.className = `todo-card${todo.done ? ' is-done' : ''}`;
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = todo.done;
    check.addEventListener('change', async () => {
      const result = await store.mutate(board => setTodoDone(board, todo.id, check.checked));
      if (!result.ok) $('#todo-feedback').textContent = result.message;
    });
    const title = document.createElement('strong');
    title.textContent = todo.title;
    label.append(check, title);
    row.append(label);
    if (todo.details) {
      const details = document.createElement('p');
      details.textContent = todo.details;
      row.append(details);
    }
    const bottom = document.createElement('div');
    bottom.className = 'todo-card-bottom';
    const source = document.createElement('small');
    source.textContent = todo.source === 'plan' ? todo.section : todo.source === 'agent' ? 'Added by an agent' : 'Added by you';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'job-return';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove todo: ${todo.title}`);
    remove.addEventListener('click', async () => {
      const result = await store.mutate(board => removeTodo(board, todo.id));
      if (!result.ok) $('#todo-feedback').textContent = result.message;
    });
    bottom.append(source, remove);
    row.append(bottom);
    return row;
  }

  function render() {
    const todos = store.getBoard().todos.filter(todo => !todo.hidden);
    const open = todos.filter(todo => !todo.done).reverse();
    const done = todos.filter(todo => todo.done).reverse();
    $('#noticeboard-count').textContent = open.length;
    if (!panel.open) return;
    list.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = `${open.length} to do`;
    list.append(heading);
    for (const todo of open) list.append(taskCard(todo));
    if (!open.length) {
      const empty = document.createElement('p'); empty.className = 'todo-empty';
      empty.textContent = 'All clear for now. Pin a task or ask the agents for an idea.'; list.append(empty);
    }
    if (done.length) {
      const history = document.createElement('details');
      history.className = 'todo-history';
      const summary = document.createElement('summary');
      summary.textContent = `${done.length} finished task${done.length === 1 ? '' : 's'}`;
      history.append(summary, ...done.map(taskCard));
      list.append(history);
    }
    $('#agent-todos').disabled = asking;
    $('#agent-todos').textContent = asking ? 'Agents are thinking…' : 'Ask the agents for tasks';
  }

  function open() {
    onBeforeOpen?.();
    panel.showModal();
    render();
  }

  $('#open-noticeboard').addEventListener('click', open);
  $('#close-noticeboard').addEventListener('click', () => panel.close());
  $('#todo-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await store.mutate(board => addTodo(board, { title: $('#todo-title').value,
      details: $('#todo-details').value, source: 'user' }));
    $('#todo-feedback').textContent = result.ok ? 'Pinned to the noticeboard.' : result.message;
    if (result.ok) $('#todo-form').reset();
  });
  $('#agent-todos').addEventListener('click', async () => {
    if (asking) return;
    const selected = getModel();
    if (!selected) { $('#todo-feedback').textContent = 'Choose a model in the Workbench first.'; return; }
    asking = true;
    $('#todo-feedback').textContent = 'The agents are looking for useful next tasks…';
    render();
    try {
      const response = await fetch('/api/agents/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'todos', title: 'Next tasks for AgentIsland',
          description: todoContext(store.getBoard()), ...selected }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.text !== 'string') throw new Error(data.error || 'The agents could not suggest tasks.');
      const suggestions = parseTodoResponse(data.text);
      const result = await store.mutate(board => {
        let added = 0;
        for (const todo of suggestions) if (addTodo(board, { ...todo, source: 'agent' }).ok) added++;
        return { ok: true, added };
      });
      $('#todo-feedback').textContent = result.added
        ? `${result.added} task${result.added === 1 ? '' : 's'} added by the agents.`
        : 'Those tasks were already on the noticeboard.';
    } catch (error) { $('#todo-feedback').textContent = error.message || 'The agents could not suggest tasks.'; }
    finally { asking = false; render(); }
  });
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const bounds = panel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close();
  });
  const unsubscribe = store.subscribe(render);
  render();
  return { open, destroy() { unsubscribe(); } };
}
