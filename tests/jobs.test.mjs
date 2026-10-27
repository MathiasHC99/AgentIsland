import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobBoard, registerAgent, postJob, claimJob, completeJob,
  releaseJob, summarizeJobs, serializeJobBoard, restoreJobBoard,
} from '../dist/jobs.js';

function fixture() {
  const board = createJobBoard();
  const alice = registerAgent(board, { id: 'alice', name: 'Alice' }).agent;
  const bob = registerAgent(board, { id: 'bob', name: 'Bob' }).agent;
  const first = postJob(board, { title: 'Plan the island', description: 'Find space for the next station.', priority: 'high' }).job;
  const second = postJob(board, { title: 'Collect ideas' }).job;
  return { board, alice, bob, first, second };
}

test('jobs start available with stable unique identities and normalized text', () => {
  const board = createJobBoard();
  const first = postJob(board, { title: '  A first job  ', description: '  Details  ' }).job;
  const second = postJob(board, { title: 'A first job' }).job;
  assert.equal(first.title, 'A first job');
  assert.equal(first.description, 'Details');
  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'available');
  assert.equal(first.priority, 'normal');
  assert.equal(first.claimedBy, null);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.deepEqual(summarizeJobs(board), { available: 2, inProgress: 0, completed: 0, total: 2, idleAgents: 0, busyAgents: 0 });
});

test('competing claims award one job once and leave the other agent idle', () => {
  const { board, alice, bob, first } = fixture();
  assert.equal(claimJob(board, first.id, alice.id).ok, true);
  const afterFirst = structuredClone(board);
  assert.equal(claimJob(board, first.id, bob.id).reason, 'job_unavailable');
  assert.deepEqual(board, afterFirst);
  assert.equal(first.claimedBy, alice.id);
  assert.equal(alice.status, 'busy');
  assert.equal(alice.jobId, first.id);
  assert.equal(bob.status, 'idle');
});

test('busy agents cannot pick up another job and re-registering cannot reset them', () => {
  const { board, alice, first, second } = fixture();
  claimJob(board, first.id, alice.id);
  const result = claimJob(board, second.id, alice.id);
  assert.equal(result.reason, 'agent_busy');
  assert.equal(second.status, 'available');
  assert.equal(registerAgent(board, { id: alice.id, name: 'Changed name' }).agent, alice);
  assert.equal(alice.status, 'busy');
  assert.equal(alice.name, 'Alice');
  assert.equal(board.agents.length, 2);
});

test('completion and return require ownership and return agents to idle', () => {
  const { board, alice, bob, first, second } = fixture();
  claimJob(board, first.id, alice.id);
  const claimed = structuredClone(board);
  assert.equal(completeJob(board, first.id, bob.id).reason, 'not_job_owner');
  assert.equal(releaseJob(board, first.id, bob.id).reason, 'not_job_owner');
  assert.deepEqual(board, claimed);
  assert.equal(completeJob(board, first.id, alice.id).ok, true);
  assert.equal(first.status, 'completed');
  assert.equal(first.claimedBy, alice.id);
  assert.ok(first.completedAt);
  assert.equal(alice.status, 'idle');
  assert.equal(alice.jobId, null);
  assert.equal(claimJob(board, first.id, bob.id).reason, 'job_unavailable');
  assert.equal(completeJob(board, first.id, alice.id).reason, 'job_not_in_progress');
  assert.equal(claimJob(board, second.id, alice.id).ok, true);
  assert.equal(releaseJob(board, second.id, alice.id).ok, true);
  assert.equal(second.status, 'available');
  assert.equal(second.claimedBy, null);
  assert.equal(second.claimedAt, null);
  assert.equal(alice.status, 'idle');
  assert.equal(claimJob(board, second.id, bob.id).ok, true);
  assert.deepEqual(summarizeJobs(board), { available: 0, inProgress: 1, completed: 1, total: 2, idleAgents: 1, busyAgents: 1 });
});

test('invalid posting, registration, and unknown identities do not mutate the board', () => {
  const { board, alice, first } = fixture();
  const before = structuredClone(board);
  for (const input of [null, {}, { title: '  ' }, { title: 'a'.repeat(121) }, { title: 'Valid', description: 'a'.repeat(2001) }, { title: 'Valid', description: 42 }, { title: 'Valid', priority: 'urgent' }]) {
    assert.equal(postJob(board, input).ok, false);
  }
  for (const input of [null, {}, { id: '', name: 'Agent' }, { id: 'agent', name: ' ' }, { id: 'agent', name: 'a'.repeat(61) }]) {
    assert.equal(registerAgent(board, input).ok, false);
  }
  assert.equal(claimJob(board, first.id, 'unknown').reason, 'agent_not_found');
  assert.equal(claimJob(board, 'unknown', alice.id).reason, 'job_not_found');
  assert.equal(completeJob(board, first.id, 'unknown').reason, 'agent_not_found');
  assert.equal(releaseJob(board, 'unknown', alice.id).reason, 'job_not_found');
  assert.deepEqual(board, before);
});

test('restoring a board preserves completed history and current assignments independently', () => {
  const { board, alice, first, second } = fixture();
  claimJob(board, first.id, alice.id);
  completeJob(board, first.id, alice.id);
  claimJob(board, second.id, alice.id);
  const serialized = serializeJobBoard(board);
  const restored = restoreJobBoard(serialized);
  assert.deepEqual(restored, board);
  assert.notEqual(restored, board);
  assert.equal(claimJob(restored, second.id, 'bob').reason, 'job_unavailable');
  assert.equal(releaseJob(restored, second.id, alice.id).ok, true);
  assert.equal(restored.jobs[0].status, 'completed');
  assert.equal(board.jobs[1].status, 'in_progress');
});

test('corrupt storage rejects malformed schemas, duplicate IDs, and inconsistent assignments', () => {
  const { board, alice, first } = fixture();
  claimJob(board, first.id, alice.id);
  const corruptions = [
    data => { data.version = 2; },
    data => { data.jobs.push({ ...data.jobs[0] }); },
    data => { data.agents.push({ ...data.agents[0] }); },
    data => { data.jobs[0].claimedBy = 'missing'; },
    data => { data.agents[0].status = 'idle'; data.agents[0].jobId = null; },
    data => { data.agents[0].jobId = 'missing'; },
    data => { data.jobs[0].status = 'available'; },
    data => { data.jobs[0].createdAt = 'invalid'; },
    data => { data.jobs[0].title = ''; },
    data => { data.jobs[0].priority = 'unknown'; },
    data => { data.jobs[0].completedAt = new Date().toISOString(); },
    data => { data.jobs[0].claimedAt = '2000-01-01T00:00:00Z'; },
    data => { data.jobs[1].status = 'in_progress'; data.jobs[1].claimedBy = alice.id; data.jobs[1].claimedAt = new Date().toISOString(); },
  ];
  for (const corrupt of corruptions) {
    const data = structuredClone(board);
    corrupt(data);
    assert.deepEqual(restoreJobBoard(JSON.stringify(data)), createJobBoard());
    assert.throws(() => serializeJobBoard(data), TypeError);
  }
  for (const input of [null, undefined, '', 'invalid JSON', '{}', '[]', '{"version":1,"jobs":null,"agents":[]}']) {
    assert.deepEqual(restoreJobBoard(input), createJobBoard());
  }
});
