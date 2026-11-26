import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardStore } from '../src/client/state/board-store.js';
import { postJob, postHelpRequest, startTeamRun, stopTeamRun } from '../src/client/domain/jobs.js';
import { initHelpdeskWorker } from '../src/client/agents/helpdesk-worker.js';

async function fixture() {
  const store = createBoardStore({ storage: null, locks: null, eventTarget: null });
  const { job } = await store.mutate(board => postJob(board, { title: 'test 3' }));
  await store.mutate(board => startTeamRun(board, job.id, 'old-run'));
  await store.mutate(board => stopTeamRun(board, job.id, 'old-run', 'Model call failed'));
  const { request } = await store.mutate(board => postHelpRequest(board, {
    title: 'Agent help: test 3', details: 'The final step failed.', author: 'Island lead', jobId: job.id,
  }));
  return { store, job, request };
}

test('the Helpdesk agent picks a queued request and resumes a failed job after guidance', async () => {
  const { store, job, request } = await fixture();
  const seen = [];
  const unsubscribe = store.subscribe(board => seen.push(board.helpRequests[0].helperStatus));
  let resume;
  const resumed = new Promise(resolve => { resume = resolve; });
  const worker = initHelpdeskWorker({ store,
    fetchImpl: async path => path.endsWith('/status')
      ? Response.json({ providers: [{ id: 'ollama', models: ['qwen2.5:7b'] }] })
      : Response.json({ text: JSON.stringify({ resolved: true, guidance: 'Try a shorter final response.' }) }),
    onResolved: (jobId, guidance, model) => {
      resume({ jobId, guidance, model });
      return { status: 'completed' };
    },
  });
  assert.deepEqual(await resumed, { jobId: job.id, guidance: 'Try a shorter final response.',
    model: { provider: 'ollama', model: 'qwen2.5:7b' } });
  assert.ok(seen.includes('working'));
  assert.equal(store.getBoard().helpRequests[0].status, 'resolved');
  assert.equal(store.getBoard().helpRequests[0].helperStatus, 'answered');
  worker.destroy(); unsubscribe(); store.destroy();
});

test('an unresolved queued request alerts the job owner after an agent tries it', async () => {
  const { store, job } = await fixture();
  let alert;
  const alerted = new Promise(resolve => { alert = resolve; });
  const worker = initHelpdeskWorker({ store,
    fetchImpl: async path => path.endsWith('/status')
      ? Response.json({ providers: [{ id: 'ollama', models: ['qwen2.5:7b'] }] })
      : Response.json({ text: JSON.stringify({ resolved: false, guidance: "This needs the user's choice." }) }),
    notifyHuman: event => alert(event),
  });
  const event = await alerted;
  assert.equal(event.jobId, job.id);
  assert.equal(event.type, 'failed');
  assert.equal(store.getBoard().helpRequests[0].helperStatus, 'needs_human');
  worker.destroy(); store.destroy();
});

test('an older timed-out job gets the known fix and an automatic retry', async () => {
  const { store, job } = await fixture();
  await store.mutate(board => {
    board.helpRequests[0].details = 'Issue: The team request was stopped or timed out.';
    return { ok: true };
  });
  let resumed;
  const complete = new Promise(resolve => { resumed = resolve; });
  const worker = initHelpdeskWorker({ store,
    fetchImpl: async path => {
      assert.ok(path.endsWith('/status'), 'The known timeout should not spend a model call');
      return Response.json({ providers: [{ id: 'ollama', models: ['qwen2.5:7b'] }] });
    },
    onResolved: (jobId, guidance) => { resumed({ jobId, guidance }); return { status: 'completed' }; },
  });
  const result = await complete;
  assert.equal(result.jobId, job.id);
  assert.match(result.guidance, /no fixed app time limit/);
  assert.equal(store.getBoard().helpRequests[0].status, 'resolved');
  worker.destroy(); store.destroy();
});

test('one Helpdesk agent finishes its current request before taking the next', async () => {
  const { store, request: first } = await fixture();
  const { request: second } = await store.mutate(board => postHelpRequest(board, {
    title: 'Another question', details: 'What should I do?', author: 'You',
  }));
  let releaseFirst;
  const firstAnswer = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let secondFinished;
  const finished = new Promise(resolve => { secondFinished = resolve; });
  const calls = [];
  const worker = initHelpdeskWorker({ store, fetchImpl: async (path, options) => {
    if (path.endsWith('/status')) return Response.json({ providers: [{ id: 'ollama', models: ['test-model'] }] });
    const title = JSON.parse(options.body).title;
    calls.push(title);
    if (title === first.title) {
      firstStarted();
      await firstAnswer;
    } else secondFinished();
    return Response.json({ text: JSON.stringify({ resolved: true, guidance: 'Answered.' }) });
  } });
  await started;
  assert.equal(store.getBoard().helpRequests.find(item => item.id === first.id).helperStatus, 'working');
  assert.equal(store.getBoard().helpRequests.find(item => item.id === second.id).helperStatus, 'queued');
  assert.deepEqual(calls, [first.title]);
  releaseFirst();
  await finished;
  await new Promise(resolve => {
    const unsubscribe = store.subscribe(board => {
      if (board.helpRequests.find(item => item.id === second.id)?.helperStatus === 'answered') {
        unsubscribe(); resolve();
      }
    });
    if (store.getBoard().helpRequests.find(item => item.id === second.id)?.helperStatus === 'answered') {
      unsubscribe(); resolve();
    }
  });
  assert.deepEqual(calls, [first.title, second.title]);
  assert.equal(store.getBoard().helpRequests.find(item => item.id === first.id).helperStatus, 'answered');
  worker.destroy(); store.destroy();
});
