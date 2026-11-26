import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleAgentRequest } from '../src/server/api.mjs';

const origin = 'http://localhost:4173';
const env = { OPENAI_API_KEY: 'test-only-secret' };
function stepRequest(input, extraHeaders = {}) {
  return new Request(origin + '/api/agents/step', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(input),
  });
}

function ollamaStream(...parts) {
  return new Response(parts.map(part => JSON.stringify(part)).join('\n') + '\n',
    { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('status exposes the configured model, while missing credentials leave all jobs local', async () => {
  const status = new Request(origin + '/api/agents/status');
  assert.deepEqual(await (await handleAgentRequest(status, {})).json(), { configured: false, providers: [] });
  assert.deepEqual(await (await handleAgentRequest(status, { ...env, OPENAI_MODEL: 'deployment-model' })).json(),
    { configured: true, providers: [{ id: 'openai', label: 'OpenAI', models: ['deployment-model'] }] });
  const result = await handleAgentRequest(stepRequest({ title: 'Draft a menu', stage: 'plan' }), {}, assert.fail);
  assert.equal(result.status, 503);
});

test('local Ollama models appear in status and run without an OpenAI key', async () => {
  const local = { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
  const calls = [];
  const upstream = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/tags')) return Response.json({ models: [
      { name: 'gemma3:4b', capabilities: ['completion'] },
      { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
    ] });
    return ollamaStream({ response: 'Local ', done: false }, { response: 'draft', done: true });
  };
  const status = await handleAgentRequest(new Request(origin + '/api/agents/status'), local, upstream);
  assert.deepEqual(await status.json(), { configured: true, providers: [
    { id: 'ollama', label: 'Ollama (local)', models: ['gemma3:4b'] },
  ] });
  const response = await handleAgentRequest(stepRequest({ stage: 'plan', title: 'A menu', provider: 'ollama', model: 'gemma3:4b' }), local, upstream);
  assert.deepEqual(await response.json(), { text: 'Local draft' });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(calls.at(-1).init.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls.at(-1).init.body).stream, true);
  assert.equal((await handleAgentRequest(stepRequest({ stage: 'plan', title: 'A menu', provider: 'ollama', model: 'not-installed' }), local, upstream)).status, 400);
  const remote = await handleAgentRequest(new Request(origin + '/api/agents/status'),
    { OLLAMA_BASE_URL: 'http://example.com:11434' }, () => assert.fail('Remote host must not be contacted'));
  assert.equal((await remote.json()).configured, false);
});

test('Ollama brainstorming requests JSON without spending tokens on thinking', async () => {
  const local = { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
  let sent;
  const upstream = async (url, init) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.5:4b', capabilities: ['completion'] }] });
    sent = JSON.parse(init.body);
    return ollamaStream({ response: '{"ideas":[{"title":"Tiny game","why":"Fun","doneWhen":"Playable"}]}', done: true });
  };
  const result = await handleAgentRequest(stepRequest({ stage: 'ideas', title: 'Project ideas',
    description: 'Existing jobs: welcome page', provider: 'ollama', model: 'qwen3.5:4b' }), local, upstream);
  assert.equal(result.status, 200);
  assert.equal(sent.format, 'json');
  assert.equal(sent.think, false);
  assert.match(sent.prompt, /Existing jobs: welcome page/);
});

test('an interrupted Ollama stream does not become a finished team step', async () => {
  const local = { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
  const upstream = async url => url.endsWith('/api/tags')
    ? Response.json({ models: [{ name: 'gemma3:4b', capabilities: ['completion'] }] })
    : ollamaStream({ response: 'Partial draft', done: false });
  const response = await handleAgentRequest(stepRequest({ stage: 'plan', title: 'A menu',
    provider: 'ollama', model: 'gemma3:4b' }), local, upstream);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /usable text result/);
});

test('job notifications forward valid events to a configured n8n webhook', async t => {
  const event = {
    id: 'event-12345678', type: 'needs_approval', jobId: 'job-12345678',
    title: 'Welcome', occurredAt: new Date().toISOString(), detail: '',
  };
  const request = body => new Request(origin + '/api/notifications/event', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let forwarded;
  const receiver = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    forwarded = { path: req.url, token: req.headers['x-agentisland-token'], body: JSON.parse(body) };
    res.writeHead(200).end('accepted');
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => { receiver.closeAllConnections(); receiver.close(); });
  const target = {
    N8N_WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/webhook/island-events`,
    N8N_WEBHOOK_TOKEN: 'test-only-token',
  };
  assert.equal((await handleAgentRequest(request(event), {})).status, 503);
  assert.equal((await handleAgentRequest(request({ ...event, type: 'unknown' }), target)).status, 400);
  assert.equal((await handleAgentRequest(request(event), { N8N_WEBHOOK_URL: 'http://untrusted.example/webhook' })).status, 503);
  const response = await handleAgentRequest(request({ ...event, notificationEmail: 'spoofed@example.com' }), target);
  assert.deepEqual(await response.json(), { delivered: true });
  assert.equal(forwarded.path, '/webhook/island-events');
  assert.equal(forwarded.token, 'test-only-token');
  assert.deepEqual(forwarded.body, event);
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
