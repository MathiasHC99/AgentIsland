import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationQueue } from '../src/client/state/notification-queue.js';

test('failed delivery stays queued and retry removes only acknowledged events', async () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const event = { id: 'event-12345678', type: 'completed' };
  const queue = createNotificationQueue({ storage, fetchImpl: async () => new Response(null, { status: 502 }) });
  await queue.add(event);
  assert.equal(queue.pendingCount, 1);
  let sent;
  const restored = createNotificationQueue({ storage, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ delivered: true });
  } });
  await restored.flush();
  assert.deepEqual(sent, event);
  assert.equal(restored.pendingCount, 0);
});
