import { appendArtifactActions } from './artifact-ui.js';

const $ = selector => document.querySelector(selector);

export function initShowcase({ store, onBeforeOpen }) {
  const panel = $('#showcase-panel');
  const list = $('#showcase-list');

  function render() {
    if (!panel.open) return;
    list.replaceChildren();
    const finished = store.getBoard().jobs.filter(job => job.status === 'completed')
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    if (!finished.length) {
      const empty = document.createElement('p');
      empty.className = 'showcase-empty';
      empty.textContent = 'The first finished project will get a place here.';
      list.append(empty);
      return;
    }
    for (const job of finished) {
      const card = document.createElement('article');
      card.className = 'showcase-card';
      const date = document.createElement('small');
      date.textContent = new Date(job.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const title = document.createElement('h3');
      title.textContent = job.title;
      card.append(date, title);
      if (job.description) {
        const description = document.createElement('p');
        description.textContent = job.description;
        card.append(description);
      }
      if (job.teamRun?.final) {
        const result = document.createElement('details');
        result.className = 'showcase-result';
        const summary = document.createElement('summary');
        summary.textContent = 'Read the result';
        const content = document.createElement('pre');
        content.textContent = job.teamRun.final;
        result.append(summary, content);
        card.append(result);
        appendArtifactActions(card, job);
      }
      list.append(card);
    }
  }

  function open() {
    onBeforeOpen?.();
    panel.showModal();
    render();
  }

  $('#open-showcase').addEventListener('click', open);
  $('#close-showcase').addEventListener('click', () => panel.close());
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const box = panel.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) panel.close();
  });
  const unsubscribe = store.subscribe(render);
  return { open, destroy() { unsubscribe(); } };
}
