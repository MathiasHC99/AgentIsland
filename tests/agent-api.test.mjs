import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleAgentRequest } from '../agent-api.mjs';

const origin = 'http://localhost:4173';
const env = { OPENAI_API_KEY: 'test-only-secret' };
function stepRequest(input, extraHeaders = {}) {
  return new Request(origin + '/api/agents/step', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(input),
  });
}

test('status exposes the configured model, while missing credentials leave all jobs local', async () => {
  const status = new Request(origin + '/api/agents/status');
  assert.deepEqual(await (await handleAgentRequest(status, {})).json(), { configured: false, model: 'gpt-4.1-mini' });
  assert.deepEqual(await (await handleAgentRequest(status, { ...env, OPENAI_MODEL: 'deployment-model' })).json(),
    { configured: true, model: 'deployment-model' });
  const result = await handleAgentRequest(stepRequest({ title: 'Draft a menu', stage: 'plan' }), {}, assert.fail);
  assert.equal(result.status, 503);
});

test('malformed, oversized, incomplete and foreign-origin requests do not call the provider', async () => {
  for (const [request, status] of [
    [stepRequest({ title: 'Menu', stage: 'draft', plan: '' }), 400],
    [stepRequest({ title: 'Menu', stage: 'check', draft: 'Draft' }), 400],
    [stepRequest({ title: 'Menu', stage: 'constructor' }), 400],
    [stepRequest({ title: 'X'.repeat(300_000), stage: 'plan' }), 413],
    [stepRequest({ title: 'Menu', stage: 'plan' }, { origin: 'https://other.example' }), 403],
    [stepRequest({ title: 'Menu', stage: 'plan' }, { 'Content-Type': 'text/plain' }), 415],
  ]) assert.equal((await handleAgentRequest(request, env, assert.fail)).status, status);
});

test('four distinct role calls exchange the actual plan, draft and findings over HTTP', async t => {
  const captured = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    captured.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Output ' + captured.length }] },
    ] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const upstream = (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return fetch('http://127.0.0.1:' + provider.address().port + new URL(url).pathname, init);
  };
  const job = { title: 'A winter menu', description: 'Three courses', previous: 'A spring menu', feedback: 'Use winter fruit' };
  for (const [i, stage] of ['plan', 'draft', 'check', 'final'].entries()) {
    const result = await handleAgentRequest(stepRequest({ ...job, stage }), env, upstream);
    assert.equal(result.status, 200);
    const { text } = await result.json();
    const call = captured[i];
    assert.equal(call.path, '/v1/responses');
    assert.equal(call.authorization, 'Bearer test-only-secret');
    assert.equal(call.body.store, false);
    assert.deepEqual(JSON.parse(call.body.input), job);
    assert.equal(text, 'Output ' + (i + 1));
    job[stage] = text;
  }
  assert.equal(new Set(captured.map(call => call.body.instructions)).size, 4);
});

test('provider failures and partial responses produce actionable errors without forwarding credentials', async () => {
  const request = () => stepRequest({ title: 'Menu', stage: 'plan' });
  for (const [fetchProvider, status] of [
    [async () => { throw new Error('Network failure ' + env.OPENAI_API_KEY); }, 502],
    [async () => new Response(env.OPENAI_API_KEY, { status: 401 }), 502],
    [async () => new Response(env.OPENAI_API_KEY, { status: 429 }), 429],
    [async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })), 502],
    [async () => new Response('invalid JSON'), 502],
  ]) {
    const response = await handleAgentRequest(request(), env, fetchProvider);
    assert.equal(response.status, status);
    const { error } = await response.json();
    assert.ok(error && !error.includes(env.OPENAI_API_KEY));
  }
});
