import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardStore } from '../src/client/state/board-store.js';
import { postJob } from '../src/client/domain/jobs.js';
import { runAutonomousJob } from '../src/client/agents/autonomous-team.js';
import { shouldAbortTeamRun } from '../src/client/ui/team-ui.js';
import { initHelpdeskWorker } from '../src/client/agents/helpdesk-worker.js';

async function setup() {
  const events = [];
  const store = createBoardStore({ storage: null, locks: null, eventTarget: null, onJobEvent: event => events.push(event) });
  const { job } = await store.mutate(board => postJob(board, { title: 'Write a welcome sentence' }));
  return { store, job, events };
}

test('agents test and approve a routine job without human action', async () => {
  const { store, job, events } = await setup();
  const calls = [];
  const outcome = await runAutonomousJob({
    store, jobId: job.id, smokeTest: async () => 'No browser artifact requested.',
    callStep: async input => {
      calls.push(input.stage);
      if (input.stage === 'test') return JSON.stringify({ passed: true, needsHuman: false, notes: 'The sentence matches the request.' });
      if (input.stage === 'review') return JSON.stringify({ approved: true, needsHuman: false, notes: 'Requirements met.' });
      return input.stage + ' text';
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(store.getBoard().jobs[0].status, 'completed');
  assert.deepEqual(calls, ['plan', 'draft', 'check', 'final', 'test', 'review']);
  assert.deepEqual(events.map(event => event.type), ['completed']);
  store.destroy();
});

test('the Helpdesk resolves a failed check before one automatic revision', async () => {
  const { store, job, events } = await setup();
  const worker = initHelpdeskWorker({ store, fetchImpl: async path => path.endsWith('/status')
    ? Response.json({ providers: [{ id: 'ollama', models: ['test-model'] }] })
    : Response.json({ text: JSON.stringify({ resolved: true, guidance: 'Add a greeting before the welcome.' }) }) });
  let tests = 0;
  const feedback = [];
  const outcome = await runAutonomousJob({
    store, jobId: job.id, smokeTest: async () => 'No browser artifact requested.',
    callStep: async input => {
      if (input.stage === 'plan') feedback.push(input.feedback);
      if (input.stage === 'test') return JSON.stringify({ passed: ++tests > 1, needsHuman: false, notes: tests === 1 ? 'Missing greeting.' : 'Greeting added.' });
      if (input.stage === 'review') return JSON.stringify({ approved: true, needsHuman: false, notes: 'Ready.' });
      return input.stage + ' text';
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(tests, 2);
  assert.match(feedback[1], /Helpdesk guidance: Add a greeting/);
  assert.equal(store.getBoard().helpRequests[0].status, 'resolved');
  assert.deepEqual(events.map(event => event.type), ['completed']);
  worker.destroy();
  store.destroy();
});

test('the Helpdesk is consulted before an unresolved job asks for a human', async () => {
  const { store, job, events } = await setup();
  const worker = initHelpdeskWorker({ store, fetchImpl: async path => path.endsWith('/status')
    ? Response.json({ providers: [{ id: 'ollama', models: ['test-model'] }] })
    : Response.json({ text: JSON.stringify({ resolved: false, guidance: 'Brand approval is unavailable to the team.' }) }) });
  const helperStates = [];
  const unsubscribe = store.subscribe(board => {
    if (board.helpRequests[0]) helperStates.push(board.helpRequests[0].helperStatus);
  });
  const contacted = [];
  const outcome = await runAutonomousJob({
    store, jobId: job.id, smokeTest: async () => 'No browser artifact requested.',
    notifyHuman: event => contacted.push(event),
    callStep: async input => {
      if (input.stage === 'test') return JSON.stringify({ passed: false, needsHuman: true, notes: 'A brand owner must confirm this wording.' });
      return input.stage + ' text';
    },
  });
  assert.equal(outcome.status, 'needs_human');
  assert.equal(store.getBoard().jobs[0].status, 'testing');
  assert.equal(store.getBoard().helpRequests[0].status, 'open');
  assert.ok(helperStates.includes('working'));
  assert.equal(store.getBoard().helpRequests[0].helperStatus, 'needs_human');
  assert.equal(contacted[0].type, 'failed');
  assert.deepEqual(events, []);
  unsubscribe();
  worker.destroy();
  store.destroy();
});

test('a failed lead step reaches the queued Helpdesk agent before alerting the human', async () => {
  const { store, job } = await setup();
  const worker = initHelpdeskWorker({ store, fetchImpl: async path => path.endsWith('/status')
    ? Response.json({ providers: [{ id: 'ollama', models: ['test-model'] }] })
    : Response.json({ text: JSON.stringify({ resolved: false, guidance: 'A person can retry with a faster model.' }) }) });
  const controller = new AbortController();
  const stages = [];
  const alerts = [];
  const active = { claimed: true, id: 'run-timeout' };
  const unsubscribe = store.subscribe(board => {
    const run = board.jobs.find(item => item.id === job.id)?.teamRun;
    if (shouldAbortTeamRun(active, run)) controller.abort();
  });
  const outcome = await runAutonomousJob({
    store, jobId: job.id, signal: controller.signal, newRunId: () => active.id,
    smokeTest: async () => '', notifyHuman: event => alerts.push(event),
    callStep: async input => {
      stages.push(input.stage);
      if (input.stage === 'final') throw new Error('The model connection failed while finishing.');
      return input.stage + ' text';
    },
  });
  assert.equal(controller.signal.aborted, false);
  assert.equal(outcome.status, 'needs_human');
  assert.deepEqual(stages, ['plan', 'draft', 'check', 'final']);
  assert.equal(store.getBoard().helpRequests.length, 1);
  assert.match(store.getBoard().helpRequests[0].details, /connection failed/);
  assert.equal(store.getBoard().todos.length, 1);
  assert.match(store.getBoard().todos[0].details, /connection failed/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'failed');
  assert.equal(shouldAbortTeamRun(active, { id: active.id, status: 'failed', error: 'Stopped by you.' }), true);
  unsubscribe();
  worker.destroy();
  store.destroy();
});
