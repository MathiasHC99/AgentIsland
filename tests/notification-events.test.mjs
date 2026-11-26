import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobBoard, postJob, startTeamRun, saveTeamStep, stopTeamRun,
  recordTestResult, recordReviewDecision,
} from '../src/client/domain/jobs.js';
import { snapshotJobs, jobEvents } from '../src/client/domain/notification-events.js';

test('job transitions produce one notification for review, approval, completion, and failure', () => {
  const board = createJobBoard();
  const job = postJob(board, { title: 'Welcome message' }).job;
  const changed = action => {
    const before = snapshotJobs(board);
    assert.equal(action().ok, true);
    return jobEvents(before, board, () => 'event-12345678');
  };
  assert.deepEqual(changed(() => startTeamRun(board, job.id, 'run-1')), []);
  for (const stage of ['plan', 'draft', 'check']) {
    assert.deepEqual(changed(() => saveTeamStep(board, job.id, 'run-1', stage, stage + ' text')), []);
  }
  assert.deepEqual(changed(() => saveTeamStep(board, job.id, 'run-1', 'final', 'Result')), []);
  assert.deepEqual(changed(() => recordTestResult(board, job.id, { passed: true })), []);
  assert.equal(changed(() => recordReviewDecision(board, job.id, { approved: true }))[0].type, 'completed');

  const second = postJob(board, { title: 'Another message' }).job;
  assert.deepEqual(changed(() => startTeamRun(board, second.id, 'run-2')), []);
  assert.deepEqual(changed(() => stopTeamRun(board, second.id, 'run-2', 'Model unavailable')), []);
});
