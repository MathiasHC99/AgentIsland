const storageKey = 'agent-island.notifications.v1';

/** Retry saved events after a temporary server or n8n failure. */
export function createNotificationQueue({ storage = globalThis.localStorage, fetchImpl = fetch } = {}) {
  let pending = [];
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) pending = saved.filter(event => event && typeof event.id === 'string');
  } catch { /* Keep notifications usable in a storage-restricted browser. */ }
  let flushing = null;

  function save() {
    try { storage?.setItem(storageKey, JSON.stringify(pending)); } catch { /* Keep the in-memory queue. */ }
  }

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (pending.length) {
        let response;
        try {
          response = await fetchImpl('/api/notifications/event', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending[0]), keepalive: true,
          });
        } catch { break; }
        if (!response.ok) break;
        pending.shift();
        save();
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function add(event) {
    if (!pending.some(item => item.id === event.id)) pending.push(event);
    save();
    return flush();
  }

  return { add, flush, get pendingCount() { return pending.length; } };
}
