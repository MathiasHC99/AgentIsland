import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobBoard, postJob, deleteJob, registerAgent, claimJob, releaseJob, submitJobForTesting,
  recordTestResult, recordReviewDecision, serializeJobBoard, restoreJobBoard,
  TEAM_AGENT_ID, TEAM_STAGES, startTeamRun, saveTeamStep, stopTeamRun,
} from '../src/client/domain/jobs.js';

const roundTrip = board => restoreJobBoard(serializeJobBoard(board));

test('deleting a running AI job frees the lead and rejects late model output', () => {
  const board = createJobBoard();
  const job = postJob(board, { title: 'Old test job' }).job;
  const next = postJob(board, { title: 'Next job' }).job;
  startTeamRun(board, job.id, 'run-old');
  assert.equal(deleteJob(board, job.id).ok, true);
  assert.equal(board.agents.find(agent => agent.id === TEAM_AGENT_ID).status, 'idle');
  assert.equal(saveTeamStep(board, job.id, 'run-old', 'plan', 'Late result').ok, false);
  assert.equal(startTeamRun(board, next.id, 'run-new').ok, true);
  assert.deepEqual(roundTrip(board), board);
});

test('the lead delegates in order, saves each contribution, and sends the final to manual testing', () => {
  const board = createJobBoard();
  const job = postJob(board, { title: 'Write a welcome message' }).job;
  const other = postJob(board, { title: 'A second assignment' }).job;
  assert.equal(startTeamRun(board, job.id, 'run-1').ok, true);
  const original = structuredClone(board);
  assert.equal(startTeamRun(board, other.id, 'run-2').ok, false);
  assert.equal(saveTeamStep(board, job.id, 'run-1', 'draft', 'Out of order').ok, false);
  assert.equal(saveTeamStep(board, job.id, 'run-1', 'plan', ' '.repeat(5)).ok, false);
  assert.equal(saveTeamStep(board, job.id, 'run-1', 'plan', 'x'.repeat(12001)).ok, false);
  assert.equal(releaseJob(board, job.id, TEAM_AGENT_ID).ok, false);
  assert.equal(submitJobForTesting(board, job.id, TEAM_AGENT_ID).ok, false);
  assert.deepEqual(board, original);
  for (const stage of TEAM_STAGES) {
    assert.equal(saveTeamStep(board, job.id, 'run-1', stage, '  ' + stage + ' text  ').ok, true);
    assert.equal(job.teamRun[stage], stage + ' text');
    assert.deepEqual(roundTrip(board), board);
  }
  assert.equal(job.teamRun.status, 'submitted');
  assert.equal(job.status, 'testing');
  assert.equal(recordReviewDecision(board, job.id, { approved: true }).ok, false);
  recordTestResult(board, job.id, { passed: true });
  recordReviewDecision(board, job.id, { approved: true });
  assert.equal(job.status, 'completed');
  assert.equal(startTeamRun(board, other.id, 'run-2').ok, true);
});

test('a stopped run survives reload and rejects stale or duplicate responses after retry', () => {
  let board = createJobBoard();
  const { id } = postJob(board, { title: 'Write directions' }).job;
  startTeamRun(board, id, 'first');
  saveTeamStep(board, id, 'first', 'plan', 'Assign the draft.');
  board = roundTrip(board);
  assert.equal(startTeamRun(board, id, 'second').ok, false);
  assert.equal(stopTeamRun(board, id, 'first', 'Stopped after reload.').ok, true);
  assert.equal(startTeamRun(board, id, 'first').ok, false);
  board = roundTrip(board);
  const run = startTeamRun(board, id, 'second').job.teamRun;
  const before = structuredClone(board);
  assert.equal(run.plan, 'Assign the draft.');
  assert.equal(saveTeamStep(board, id, 'first', 'draft', 'Late response').ok, false);
  assert.equal(stopTeamRun(board, id, 'first').ok, false);
  assert.equal(saveTeamStep(board, id, 'second', 'plan', 'Duplicate').ok, false);
  assert.deepEqual(board, before);
  saveTeamStep(board, id, 'second', 'draft', 'New draft');
  stopTeamRun(board, id, 'second', 'Service unavailable');
  assert.equal(releaseJob(board, id, TEAM_AGENT_ID).ok, true);
  assert.equal(roundTrip(board).jobs[0].status, 'available');
  assert.equal(board.agents.find(agent => agent.id === TEAM_AGENT_ID).status, 'idle');
});

test('a revision keeps the submitted text and station feedback across failures and retries', () => {
  const board = createJobBoard();
  const job = postJob(board, { title: 'Outline the project' }).job;
  startTeamRun(board, job.id, 'original');
  for (const stage of TEAM_STAGES) saveTeamStep(board, job.id, 'original', stage, stage + ' original');
  recordTestResult(board, job.id, { passed: true, notes: 'Readable' });
  recordReviewDecision(board, job.id, { approved: false, notes: 'Add dates.' });
  assert.equal(startTeamRun(board, job.id, 'revision').ok, true);
  assert.equal(job.teamRun.previousFinal, 'final original');
  assert.equal(job.teamRun.plan, '');
  assert.equal(job.reviews.at(-1).notes, 'Add dates.');
  stopTeamRun(board, job.id, 'revision');
  const restored = roundTrip(board);
  assert.equal(startTeamRun(restored, job.id, 'retry').job.teamRun.previousFinal, 'final original');
});

test('jobs without agent records still load, and failed team starts leave another owner alone', () => {
  const board = createJobBoard();
  const job = postJob(board, { title: 'Review a map' }).job;
  registerAgent(board, { id: 'preview', name: 'Preview agent' });
  claimJob(board, job.id, 'preview');
  const before = roundTrip(board);
  assert.equal(before.jobs[0].teamRun, undefined);
  assert.equal(startTeamRun(board, job.id, 'try').ok, false);
  assert.deepEqual(board, before);
  releaseJob(board, job.id, 'preview');
  startTeamRun(board, job.id, 'new');
  const broken = structuredClone(board);
  broken.jobs[0].teamRun.check = 'Missing plan and draft';
  assert.throws(() => serializeJobBoard(broken), TypeError);
});
