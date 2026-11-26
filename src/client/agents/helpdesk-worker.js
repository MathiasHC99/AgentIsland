import { claimAgentHelp, finishAgentHelp, TEAM_AGENT_ID } from '../domain/jobs.js';
import { parseDecision } from './autonomous-check.js';

/** Pick up older queued requests while an island tab is open. */
export function initHelpdeskWorker({ store, notifyHuman, onResolved, fetchImpl = fetch }) {
  let working = false;
  let destroyed = false;
  let activeController = null;
  let activeRequestId = null;

  function linkedJob(board, request) {
    return board.jobs.find(job => job.id === request.jobId)
      || board.jobs.find(job => job.claimedBy === TEAM_AGENT_ID
        && request.title === `Agent help: ${job.title}`.slice(0, 120));
  }

  function alertJob(job, detail) {
    if (!job) return;
    try {
      void Promise.resolve(notifyHuman?.({ id: crypto.randomUUID(), type: 'failed',
        jobId: job.id, title: job.title, occurredAt: new Date().toISOString(),
        detail: String(detail).slice(0, 500) })).catch(() => {});
    } catch { /* The saved request still shows that help is needed. */ }
  }

  async function localModel() {
    const response = await fetchImpl('/api/agents/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('The model service is unavailable.');
    const status = await response.json();
    const provider = status.providers?.find(item => item.id === 'ollama' && item.models?.length)
      || status.providers?.find(item => item.models?.length);
    if (!provider) throw new Error('Choose an available model so the Helpdesk agent can work.');
    return { provider: provider.id, model: provider.models[0] };
  }

  async function answer(request, model, job, signal) {
    if (/The team request was stopped or timed out\./i.test(request.details)) {
      return { resolved: true, guidance: 'The old app time limit stopped the model call. Retry the unfinished step now that model calls have no fixed app time limit.' };
    }
    const response = await fetchImpl('/api/agents/step', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ stage: 'helpdesk', ...model,
        title: request.title, description: job?.description || '',
        issue: (request.details || request.title).slice(0, 2000), final: job?.teamRun?.final || '' }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.text !== 'string') throw new Error(result.error || 'The Helpdesk model did not answer.');
    return parseDecision(result.text, 'helpdesk');
  }

  async function process(request) {
    const claimed = await store.mutate(board => claimAgentHelp(board, request.id));
    if (!claimed.ok) return;
    const job = linkedJob(store.getBoard(), request);
    activeRequestId = request.id;
    activeController = new AbortController();
    let result;
    let model;
    try {
      model = await localModel();
      result = await answer(request, model, job, activeController.signal);
    } catch (error) {
      if (destroyed || activeController.signal.aborted) return;
      result = { resolved: false, guidance: `The Helpdesk agent could not finish: ${String(error.message || error).slice(0, 1000)}` };
    }
    if (destroyed || activeController.signal.aborted) return;
    const finished = await store.mutate(board => finishAgentHelp(board, request.id, result));
    if (!finished.ok) return;
    if (request.resumeOnAnswer !== false && result.resolved && job?.status === 'in_progress' && job.teamRun?.status === 'failed') {
      void Promise.resolve().then(() => onResolved?.(job.id, result.guidance, model)).then(resumed => {
        if (resumed?.status === 'failed_to_start' || resumed?.status === 'unavailable' || resumed?.status === 'error') {
          alertJob(job, 'The Helpdesk found guidance, but the job could not resume: ' + (resumed.reason || resumed.status));
        }
      }).catch(error => alertJob(job, 'The Helpdesk found guidance, but the job could not resume: ' + String(error.message || error)));
    } else if (request.resumeOnAnswer !== false && !result.resolved && job) {
      alertJob(job, result.guidance);
    }
  }

  async function pump() {
    if (working || destroyed) return;
    const request = store.getBoard().helpRequests.find(item => item.status === 'open' && item.helperStatus === 'queued');
    if (!request) return;
    working = true;
    try { await process(request); }
    catch (error) {
      if (!destroyed) {
        const current = store.getBoard().helpRequests.find(item => item.id === request.id);
        if (current?.helperStatus === 'working') {
          try { await store.mutate(board => finishAgentHelp(board, request.id, {
            resolved: false, guidance: `The Helpdesk agent stopped unexpectedly: ${String(error.message || error).slice(0, 1000)}`,
          })); } catch { /* The request remains visible for a manual retry. */ }
        }
        alertJob(linkedJob(store.getBoard(), request), 'The Helpdesk agent stopped unexpectedly. Check its request.');
      }
    }
    finally {
      working = false;
      activeController = null;
      activeRequestId = null;
      if (!destroyed) queueMicrotask(pump);
    }
  }

  const unsubscribe = store.subscribe(board => {
    if (activeRequestId && board.helpRequests.find(item => item.id === activeRequestId)?.helperStatus !== 'working') {
      activeController?.abort();
    }
    void pump();
  });
  void pump();
  return { destroy() { destroyed = true; activeController?.abort(); unsubscribe(); } };
}
