import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardStore, BOARD_STORAGE_KEY } from '../dist/board-store.js';
import { createJobBoard, postJob, claimJob, registerAgent, serializeJobBoard, restoreJobBoard, setAgentRest, postHelpRequest } from '../dist/jobs.js';

function memoryStorage(initial = null) {
  let raw = initial;
  return {
    blocked: false,
    getItem(key) { assert.equal(key, BOARD_STORAGE_KEY); if (this.blocked) throw new Error('Blocked'); return raw; },
    setItem(key, value) { assert.equal(key, BOARD_STORAGE_KEY); if (this.blocked) throw new Error('Quota exceeded'); raw = value; },
    snapshot: () => raw,
  };
}

function lockManager() {
  let tail = Promise.resolve();
  return {
    request(key, action) {
      assert.equal(key, BOARD_STORAGE_KEY);
      const task = tail.then(action);
      tail = task.catch(() => {});
      return task;
    },
  };
}

function storageEvent(key, newValue, storageArea) {
  const event = new Event('storage');
  Object.assign(event, { key, newValue, storageArea });
  return event;
}

test('shared station store persists successful mutations and leaves failed operations unsaved', async () => {
  const storage = memoryStorage();
  const store = createBoardStore({ storage, locks: null, eventTarget: null });
  let updates = 0;
  const unsubscribe = store.subscribe(board => { assert.equal(board, store.getBoard()); updates += 1; });
  assert.equal(store.storageAvailable, true);
  assert.equal((await store.mutate(board => postJob(board, { title: 'A job' }))).ok, true);
  const saved = storage.snapshot();
  assert.equal(restoreJobBoard(saved).jobs.length, 1);
  assert.equal((await store.mutate(board => postJob(board, { title: '' }))).ok, false);
  assert.equal(storage.snapshot(), saved);
  assert.equal(updates, 2);
  unsubscribe();
  await store.mutate(board => postHelpRequest(board, { title: 'Where should I start?' }));
  assert.equal(updates, 2);
  const restored = createBoardStore({ storage, locks: null, eventTarget: null });
  assert.equal(restored.getBoard().jobs.length, 1);
  assert.equal(restored.getBoard().helpRequests.length, 1);
  store.destroy(); restored.destroy();
});

test('cross-tab lock reloads the latest board and rejects a competing stale claim', async () => {
  const initial = createJobBoard();
  registerAgent(initial, { id: 'alice', name: 'Alice' });
  registerAgent(initial, { id: 'bob', name: 'Bob' });
  const job = postJob(initial, { title: 'One job' }).job;
  const storage = memoryStorage(serializeJobBoard(initial));
  const locks = lockManager();
  const first = createBoardStore({ storage, locks, eventTarget: null });
  const second = createBoardStore({ storage, locks, eventTarget: null });
  const results = await Promise.all([
    first.mutate(board => claimJob(board, job.id, 'alice')),
    second.mutate(board => claimJob(board, job.id, 'bob')),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results[1].reason, 'job_unavailable');
  assert.equal(second.getBoard().jobs[0].claimedBy, 'alice');
  await Promise.all([
    first.mutate(board => postJob(board, { title: 'From one panel' })),
    second.mutate(board => postHelpRequest(board, { title: 'From the other panel' })),
  ]);
  const saved = restoreJobBoard(storage.snapshot());
  assert.equal(saved.jobs.length, 2);
  assert.equal(saved.helpRequests.length, 1);
  first.destroy(); second.destroy();
});

test('station subscriptions see cross-tab rest changes and ignore unrelated storage', () => {
  const storage = memoryStorage();
  const events = new EventTarget();
  const store = createBoardStore({ storage, locks: null, eventTarget: events });
  let updates = 0;
  store.subscribe(() => { updates += 1; });
  const other = createJobBoard();
  registerAgent(other, { id: 'preview-agent', name: 'Preview agent' });
  setAgentRest(other, 'preview-agent', 'sleeping');
  const raw = serializeJobBoard(other);
  events.dispatchEvent(storageEvent('unrelated', raw, storage));
  events.dispatchEvent(storageEvent(BOARD_STORAGE_KEY, raw, {}));
  assert.equal(updates, 0);
  events.dispatchEvent(storageEvent(BOARD_STORAGE_KEY, raw, storage));
  assert.equal(store.getBoard().agents[0].status, 'sleeping');
  assert.equal(updates, 1);
  events.dispatchEvent(storageEvent(null, null, storage));
  assert.deepEqual(store.getBoard(), createJobBoard());
  assert.equal(updates, 2);
  store.destroy();
  events.dispatchEvent(storageEvent(BOARD_STORAGE_KEY, raw, storage));
  assert.equal(updates, 2);
});

test('failed browser storage preserves unsaved work across later edits and storage events', async () => {
  const storage = memoryStorage();
  const events = new EventTarget();
  const store = createBoardStore({ storage, locks: null, eventTarget: events });
  await store.mutate(board => postJob(board, { title: 'Already saved' }));
  const stale = storage.snapshot();
  storage.blocked = true;
  await store.mutate(board => postJob(board, { title: 'Unsaved but visible' }));
  assert.equal(store.storageAvailable, false);
  events.dispatchEvent(storageEvent(BOARD_STORAGE_KEY, stale, storage));
  assert.equal(store.getBoard().jobs.length, 2);
  await store.mutate(board => postHelpRequest(board, { title: 'Still usable in memory' }));
  assert.equal(store.getBoard().jobs.length, 2);
  assert.equal(store.getBoard().helpRequests.length, 1);
  storage.blocked = false;
  await store.mutate(board => postJob(board, { title: 'Storage is back' }));
  assert.equal(store.storageAvailable, true);
  const saved = restoreJobBoard(storage.snapshot());
  assert.equal(saved.jobs.length, 3);
  assert.equal(saved.helpRequests.length, 1);
  store.destroy();
});

test('memory-only fallback serializes local actions, and denied locks do not replay actions', async () => {
  const store = createBoardStore({ storage: null, locks: { request() { throw new Error('Denied'); } }, eventTarget: null });
  assert.equal(store.storageAvailable, false);
  await Promise.all([
    store.mutate(async board => { await Promise.resolve(); return postJob(board, { title: 'First' }); }),
    store.mutate(board => postJob(board, { title: 'Second' })),
  ]);
  assert.deepEqual(store.getBoard().jobs.map(job => job.title), ['First', 'Second']);
  store.destroy();
  assert.equal((await store.mutate(board => postJob(board, { title: 'Closed' }))).reason, 'store_destroyed');
  assert.equal(store.getBoard().jobs.length, 2);

  const locked = createBoardStore({ storage: null, locks: lockManager(), eventTarget: null });
  let calls = 0;
  await assert.rejects(locked.mutate(() => { calls += 1; throw new Error('Action failed'); }), /Action failed/);
  assert.equal(calls, 1);
  assert.equal((await locked.mutate(board => postJob(board, { title: 'Recovered' }))).ok, true);
  locked.destroy();
});
