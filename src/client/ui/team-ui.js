import {
  TEAM_AGENT_ID, TEAM_STAGES, stopTeamRun, releaseJob,
} from '../domain/jobs.js';
import { appendArtifactActions } from './artifact-ui.js';
import { runAutonomousJob } from '../agents/autonomous-team.js';
import { smokeTestDeliverable } from '../agents/autonomous-check.js';

const roles = {
  plan: { label: 'Lead · Assignment', activity: 'Lead is planning the job' },
  draft: { label: 'Writer · Draft', activity: 'Writer is drafting' },
  check: { label: 'Checker · Findings', activity: 'Checker is assessing the draft' },
  final: { label: 'Lead · Final result', activity: 'Lead is preparing the result' },
};

export function shouldAbortTeamRun(active, runState) {
  return !!active?.claimed && (runState?.id !== active.id
    || !['running', 'submitted', 'failed'].includes(runState.status)
    || runState.status === 'failed' && runState.error?.startsWith('Stopped by you.'));
}

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
    appendArtifactActions(output, job);
  }
  for (const stage of ['plan', 'draft', 'check']) {
    if (run[stage]) output.append(detail(roles[stage].label, run[stage]));
  }
  if (run.previousFinal) output.append(detail('Previous result', run.previousFinal));
  if (output.childElementCount) card.append(output);
}

export function createTeamControls({ store, render, setFilter, feedback, notifyHuman }) {
  const statusText = document.querySelector('#team-connection');
  const refreshButton = document.querySelector('#team-refresh');
  const modelSelect = document.querySelector('#team-model');
  const consentText = document.querySelector('#team-consent');
  const stationLink = document.querySelector('#team-station-link');
  const liveStatus = document.querySelector('#team-live-status');
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
      if (!Array.isArray(status.providers)) throw new Error();
      const previous = modelSelect.value;
      modelSelect.replaceChildren();
      for (const provider of status.providers) {
        for (const model of provider.models) {
          const option = node('option', '', `${provider.label} · ${model}`);
          option.value = `${provider.id}/${model}`;
          option.dataset.provider = provider.id;
          option.dataset.model = model;
          modelSelect.append(option);
        }
      }
      if ([...modelSelect.options].some(option => option.value === previous)) modelSelect.value = previous;
      configured = modelSelect.options.length > 0;
      modelSelect.disabled = !configured;
      statusText.textContent = configured
        ? `${modelSelect.options.length} model${modelSelect.options.length === 1 ? '' : 's'} available`
        : 'No models available. Start Ollama and pull a model, or configure an OpenAI key.';
      updateConsent();
    } catch {
      configured = false;
      modelSelect.disabled = true;
      statusText.textContent = 'Agent service unavailable. Check that the island server is running, then check again.';
    } finally {
      checking = false;
      refreshButton.disabled = false;
      if (!destroyed) render();
    }
  }

  function updateConsent() {
    const selected = modelSelect.selectedOptions[0];
    consentText.textContent = selected?.dataset.provider === 'ollama'
      ? 'Jobs sent to this model run through Ollama on this computer. Keep this tab open while the team works.'
      : 'Jobs sent to this model use your OpenAI API project. Keep this tab open while the team works.';
  }

  async function run(jobId, override, initialFeedback = '') {
    if (active || (!configured && !override)) return { status: 'unavailable' };
    const selected = override || modelSelect.selectedOptions[0];
    if (!selected) return;
    const provider = override?.provider || selected.dataset.provider;
    const model = override?.model || selected.dataset.model;
    const controller = new AbortController();
    active = { jobId, id: null, controller, claimed: false };
    try {
      setFilter('in_progress');
      feedback('');
      const outcome = await runAutonomousJob({
        store, jobId, signal: controller.signal, smokeTest: smokeTestDeliverable,
        notifyHuman, initialFeedback,
        onProgress: feedback,
        newRunId() { active.id = crypto.randomUUID(); active.claimed = true; return active.id; },
        async callStep(input) {
        const response = await fetch('/api/agents/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ ...input, provider, model }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || typeof result.text !== 'string') {
          throw new Error(result.error || 'The model service did not return a result. Check the connection and retry.');
        }
        return result.text;
        },
      });
      if (outcome.status === 'failed_to_start') feedback(outcome.reason, true);
      if (outcome.status === 'completed') setFilter('completed');
      return outcome;
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      const message = error instanceof TypeError ? 'Connection lost. Check the island server and retry.' : error.message;
      feedback(message, true);
      return { status: 'error', reason: message };
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
      // A model failure is saved before the Helpdesk call. Keep this attempt alive
      // until the Helpdesk has tried; explicit Stop still aborts it directly.
      if (shouldAbortTeamRun(active, runState)) active.controller.abort();
    }
    const assigned = board.jobs.find(item => item.claimedBy === TEAM_AGENT_ID && !['completed', 'available'].includes(item.status));
    const activeStage = assigned?.teamRun?.status === 'running' ? TEAM_STAGES.find(stage => !assigned.teamRun[stage]) : null;
    const role = activeStage === 'draft' ? 'Writer' : activeStage === 'check' ? 'Checker' : activeStage === 'final' || activeStage === 'plan' ? 'Island lead' : assigned?.status === 'testing' && active?.jobId === assigned.id ? 'Agent Tester' : assigned?.status === 'review' && active?.jobId === assigned.id ? 'Agent Reviewer' : null;
    liveStatus.textContent = role ? `${role} working · ${assigned.title}` : assigned ? `AI team waiting · ${assigned.title}` : 'AI team available';
    liveStatus.classList.toggle('is-working', !!role);
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
  modelSelect.addEventListener('change', updateConsent);
  return {
    refresh, update, addActions,
    runJob: (jobId, model, guidance) => run(jobId, model, guidance),
    selectedModel() {
      const option = modelSelect.selectedOptions[0];
      return configured && option ? { provider: option.dataset.provider, model: option.dataset.model } : null;
    },
    cancel(jobId) { if (active?.jobId === jobId) active.controller.abort(); },
    destroy() { destroyed = true; active?.controller.abort(); refreshButton.removeEventListener('click', refresh); modelSelect.removeEventListener('change', updateConsent); },
  };
}
