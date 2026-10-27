import { createJobBoard, serializeJobBoard, restoreJobBoard } from './jobs.js';

export const BOARD_STORAGE_KEY = 'agent-island.workbench.v1';

/** One browser-local authority shared by the island's station panels. */
export function createBoardStore(options = {}) {
  let storage;
  try { storage = 'storage' in options ? options.storage : globalThis.localStorage; }
  catch { storage = null; }
  const locks = 'locks' in options ? options.locks : globalThis.navigator?.locks;
  const eventTarget = 'eventTarget' in options ? options.eventTarget : globalThis.window;
  let board = createJobBoard();
  let storageAvailable = !!storage;
  let unsaved = false;
  let destroyed = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  function read() {
    if (!storage || !storageAvailable || unsaved) return;
    try { board = restoreJobBoard(storage.getItem(BOARD_STORAGE_KEY)); }
    catch { storageAvailable = false; }
  }

  function notify() {
    if (destroyed) return;
    for (const listener of listeners) listener(board);
  }

  function save() {
    unsaved = true;
    if (!storage) { storageAvailable = false; return; }
    try {
      storage.setItem(BOARD_STORAGE_KEY, serializeJobBoard(board));
      storageAvailable = true;
      unsaved = false;
    } catch { storageAvailable = false; }
  }

  async function perform(action) {
    if (destroyed) return { ok: false, reason: 'store_destroyed', message: 'This station is no longer open.' };
    read();
    const result = await action(board);
    if (result?.ok) save();
    notify();
    return result;
  }

  async function withLock(action) {
    if (!locks?.request) return perform(action);
    let entered = false;
    try {
      return await locks.request(BOARD_STORAGE_KEY, () => { entered = true; return perform(action); });
    } catch (error) {
      // A browser may expose Web Locks but deny them. Keep the local station usable.
      // Never retry an action which already ran and threw inside its lock.
      if (!entered) return perform(action);
      throw error;
    }
  }

  function onStorage(event) {
    if (destroyed || unsaved || (event.key !== BOARD_STORAGE_KEY && event.key !== null)) return;
    if (event.storageArea && storage && event.storageArea !== storage) return;
    board = restoreJobBoard(event.newValue);
    notify();
  }

  read();
  eventTarget?.addEventListener?.('storage', onStorage);
  return {
    getBoard: () => board,
    get storageAvailable() { return storageAvailable; },
    mutate(action) {
      if (typeof action !== 'function') return Promise.reject(new TypeError('A station mutation must be a function.'));
      const operation = queue.then(() => withLock(action));
      queue = operation.catch(() => {});
      return operation;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A station listener must be a function.');
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      eventTarget?.removeEventListener?.('storage', onStorage);
      listeners.clear();
    },
  };
}
