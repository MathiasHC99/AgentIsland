import {
  TEAM_AGENT_ID, TEAM_STAGES, startTeamRun, saveTeamStep, stopTeamRun, releaseJob,
} from './jobs.js';

const roles = {
  plan: { label: 'Lead · Assignment', activity: 'Lead is planning the job' },
  draft: { label: 'Writer · Draft', activity: 'Writer is drafting' },
  check: { label: 'Checker · Findings', activity: 'Checker is assessing the draft' },
  final: { label: 'Lead · Final result', activity: 'Lead is preparing the result' },
};

const node = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};

function button(label, className, action) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function detail(label, content) {
  const section = node('details', 'team-contribution');
  section.append(node('summary', '', label), node('p', 'team-text', content));
  return section;
}

/** A shared, text-only view of the deliverable at each station. */
export function appendTeamOutput(card, job) {
  const run = job.teamRun;
  if (!run) return;
  const output = node('section', 'team-output');
  if (run.final) {
    output.append(node('h4', '', 'Team result'), node('p', 'team-text team-result', run.final));
  }
  for (const stage of ['plan', 'draft', 'check']) {
    if (run[stage]) output.append(detail(roles[stage].label, run[stage]));
  }
  if (run.previousFinal) output.append(detail('Previous result', run.previousFinal));
  if (output.childElementCount) card.append(output);
}

function revisionNotes(job) {
  const test = job.testRuns.at(-1);
  if (test && !test.passed) return test.notes;
  const review = job.reviews.at(-1);
  return review && !review.approved ? review.notes : '';
}

export function createTeamControls({ store, render, setFilter, feedback }) {
  const statusText = document.querySelector('#team-connection');
  const refreshButton = document.querySelector('#team-refresh');
  const stationLink = document.querySelector('#team-station-link');
  let configured = false;
  let checking = false;
  let active = null;
  let destroyed = false;

  async function refresh() {
    if (checking || destroyed) return;
    checking = true;
    refreshButton.disabled = true;
    statusText.textContent = 'Checking model configuration…';
    try {
      const response = await fetch('/api/agents/status', {
        cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error();
      const status = await response.json();
      if (typeof status.configured !== 'boolean') throw new Error();
      configured = status.configured;
      statusText.textContent = configured
        ? `Configured model · ${status.model}`
        : 'Setup required. Add OPENAI_API_KEY to the island server, then check again.';
    } catch {
      configured = false;
      statusText.textContent = 'Agent service unavailable. Check that the island server is running, then check again.';
    } finally {
      checking = false;
      refreshButton.disabled = false;
      if (!destroyed) render();
    }
  }

  async function run(jobId) {
    if (active || !configured) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    active = { jobId, id, controller, claimed: false };
    try {
      const started = await store.mutate(board => startTeamRun(board, jobId, id));
      if (!started.ok) { feedback(started.message, true); return; }
      active.claimed = true;
      setFilter('in_progress');
      feedback('');
      let job = started.job;
      for (const stage of TEAM_STAGES) {
        if (job.teamRun[stage]) continue;
        const { plan, draft, check, previousFinal } = job.teamRun;
        const response = await fetch('/api/agents/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            stage, title: job.title, description: job.description, plan, draft, check,
            previous: previousFinal, feedback: revisionNotes(job),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || typeof result.text !== 'string') {
          throw new Error(result.error || 'The model service did not return a result. Check the connection and retry.');
        }
        if (controller.signal.aborted) return;
        const saved = await store.mutate(board => saveTeamStep(board, jobId, id, stage, result.text));
        if (!saved.ok) { feedback(saved.message, true); return; }
        job = saved.job;
      }
      feedback('The team submitted its result. Open Tests to check it.');
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      const message = error instanceof TypeError ? 'Connection lost. Check the island server and retry.' : error.message;
      const stopped = await store.mutate(board => stopTeamRun(board, jobId, id, message));
      feedback(stopped.ok ? message : stopped.message, true);
    } finally {
      active = null;
      if (!destroyed) render();
    }
  }

  async function stop(job) {
    const id = job.teamRun.id;
    const result = await store.mutate(board => stopTeamRun(board, job.id, id, 'Stopped by you. You can retry or return this job.'));
    if (result.ok && active?.id === id) active.controller.abort();
    feedback(result.ok ? 'Run stopped. Saved contributions are available below.' : result.message, !result.ok);
  }

  async function release(jobId) {
    const result = await store.mutate(board => releaseJob(board, jobId, TEAM_AGENT_ID));
    if (result.ok) setFilter('available');
    feedback(result.ok ? 'The job is available again.' : result.message, !result.ok);
  }

  function update(board) {
    if (active?.claimed) {
      const runState = board.jobs.find(job => job.id === active.jobId)?.teamRun;
      if (runState?.id !== active.id || runState.status !== 'running') active.controller.abort();
    }
    const job = board.jobs.find(item => item.claimedBy === TEAM_AGENT_ID && ['testing', 'review'].includes(item.status));
    stationLink.hidden = !job;
    if (job) {
      stationLink.textContent = job.status === 'testing' ? 'Open Tests' : 'Open Reviews';
      stationLink.onclick = () => document.querySelector(job.status === 'testing' ? '#open-test' : '#open-review').click();
    }
  }

  function addActions(footer, job, board) {
    const lead = board.agents.find(agent => agent.id === TEAM_AGENT_ID);
    if (job.status === 'available' || (job.claimedBy === TEAM_AGENT_ID && job.status === 'changes_requested')) {
      const label = job.status === 'available' ? 'Run with AI team' : 'Revise with AI team';
      const start = button(label, 'secondary-button team-run', () => run(job.id));
      start.disabled = !configured || !!active || (!!lead?.jobId && lead.jobId !== job.id);
      if (!configured) start.title = statusText.textContent;
      else if (start.disabled) start.title = 'The team is assigned to another job.';
      footer.append(start);
      if (job.status === 'changes_requested') footer.append(button('Return job', 'job-return', () => release(job.id)));
      return;
    }
    if (job.claimedBy !== TEAM_AGENT_ID || job.status !== 'in_progress' || !job.teamRun) return;
    const runState = job.teamRun;
    if (runState.status === 'running') {
      const stage = TEAM_STAGES.find(step => !runState[step]);
      const activity = active?.id === runState.id ? roles[stage]?.activity : 'Run started in another session. Stop it here to take over.';
      footer.append(node('span', 'team-activity', activity), button('Stop run', 'job-return team-stop', () => stop(job)));
    } else if (runState.status === 'failed') {
      const retry = button('Retry run', 'secondary-button team-retry', () => run(job.id));
      retry.disabled = !configured || !!active;
      footer.append(node('span', 'team-error', runState.error), retry, button('Return job', 'job-return', () => release(job.id)));
    }
  }

  refreshButton.addEventListener('click', refresh);
  return {
    refresh, update, addActions,
    destroy() { destroyed = true; active?.controller.abort(); refreshButton.removeEventListener('click', refresh); },
  };
}
