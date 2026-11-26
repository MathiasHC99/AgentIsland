const responsesURL = 'https://api.openai.com/v1/responses';
const maxArtifactLength = 12_000;
const stages = {
  plan: {
    requires: [],
    instructions: 'You are the Island Lead. Give your Writer a short, concrete assignment for the requested deliverable. Give your Checker clear acceptance criteria. Include any requested revisions.',
  },
  draft: {
    requires: ['plan'],
    instructions: 'You are the Writer working for the Island Lead. Carry out the writing assignment in the plan and produce the requested draft itself. Use the job requirements and incorporate any revision feedback. If the job asks for a browser app or website, make it one complete HTML file with inline CSS and JavaScript, without external files or a build step.',
  },
  check: {
    requires: ['plan', 'draft'],
    instructions: 'You are the Checker working for the Island Lead. Check the actual draft against the job and the acceptance criteria in the plan. Give specific findings, corrections and unverified claims for the Lead. Describe only checks you can perform on the supplied text.',
  },
  final: {
    requires: ['plan', 'draft', 'check'],
    instructions: 'You are the Island Lead. Combine the Writer’s draft and the Checker’s findings to produce the final deliverable requested in the job. Resolve the feedback. Return the deliverable itself in the requested format, ready for a human to test. If the job asks for a browser app or website, return only one complete self-contained HTML document with inline CSS and JavaScript; no Markdown fences, commentary, external files, or build step.',
  },
  test: {
    requires: ['final'],
    instructions: 'You are the Agent Tester. Assess the final deliverable against the job requirements and any supplied automated smoke-test evidence. Do not claim to have run checks that are not in the evidence. Return only JSON with passed (boolean), needsHuman (boolean), and notes (short specific string). Set needsHuman true when a required check needs a person or unavailable external access. Set passed false for a concrete defect.',
  },
  review: {
    requires: ['final', 'testReport'],
    instructions: 'You are the independent Agent Reviewer. Decide whether the final deliverable meets the job and the test evidence supports completion. Return only JSON with approved (boolean), needsHuman (boolean), and notes (short specific string). Approve only when requirements are met and the evidence is sufficient. Ask for a human when a subjective, external, or high-impact decision cannot be resolved by the team.',
  },
  helpdesk: {
    requires: ['issue'],
    instructions: 'You are the Helpdesk sub-agent. Diagnose the reported issue using the job, current result, and check notes. Try to find a concrete correction before escalating to a person. Return only JSON with resolved (boolean) and guidance (short specific string). Set resolved true only if the Writer can apply the correction without missing information or external access.',
  },
  ideas: {
    requires: [],
    instructions: 'You are the Island Dreamer. Propose exactly three distinct, small projects the AgentIsland team could actually make with its current text and standalone HTML abilities. Use the supplied island goals, existing jobs, and saved ideas to avoid repetition. Do not claim to know anything outside that context. Return only JSON: {"ideas":[{"title":"short project title","why":"why this would be useful or fun","doneWhen":"a concrete definition of done"}]}. Each idea should be possible as one job without external services or human decisions.',
  },
  todos: {
    requires: [],
    instructions: 'You are the Island Planner. Read the supplied island jobs, Helpdesk issues, and current noticeboard. Suggest one to three specific, useful next tasks that are not already listed. Focus on small work the team or user can actually do. Return only JSON: {"todos":[{"title":"actionable task","details":"why or how to do it"}]}. Do not claim you performed the tasks.',
  },
};

const limits = {
  title: 120, description: 2_000, plan: maxArtifactLength, draft: maxArtifactLength,
  check: maxArtifactLength, final: maxArtifactLength, testReport: 2_000,
  issue: 2_000, smoke: 2_000, previous: maxArtifactLength, feedback: 4_000,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

class SizeLimitError extends Error {}

async function readJson(message, maximumBytes) {
  if (Number(message.headers.get('content-length')) > maximumBytes) throw new SizeLimitError();
  const reader = message.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const decoder = new TextDecoder();
  let content = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        void reader.cancel().catch(() => {});
        throw new SizeLimitError();
      }
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(content + decoder.decode());
}

async function readOllamaStream(message) {
  const reader = message.body?.getReader();
  if (!reader) throw new Error('Missing Ollama response body');
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let bytes = 0;
  let finished = false;
  const parseLine = line => {
    if (!line.trim()) return;
    const part = JSON.parse(line);
    if (typeof part.response === 'string') output += part.response;
    if (output.length > maxArtifactLength) throw new SizeLimitError();
    if (part.done === true) finished = true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 384 * 1024) throw new SizeLimitError();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    parseLine(buffer + decoder.decode());
    if (!finished || !output.trim()) throw new Error('Incomplete Ollama response');
    return output.trim();
  } finally {
    reader.releaseLock();
  }
}

function prepareStep(input) {
  if (!input || typeof input.stage !== 'string' || !Object.hasOwn(stages, input.stage)) return null;
  const stage = stages[input.stage];
  const context = {};
  for (const field of ['title', 'description', 'previous', 'feedback', 'smoke', ...stage.requires]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > limits[field]) return null;
    if (!value.trim() && (field === 'title' || stage.requires.includes(field))) return null;
    if (value.trim()) context[field] = value.trim();
  }
  return { stage: input.stage, instructions: stage.instructions, context, provider: input.provider, model: input.model };
}

function providerFailure(status) {
  if (status === 401 || status === 403) return json({ error: 'OpenAI denied access. Check the server API key and its model permissions.' }, 502);
  if (status === 429) return json({ error: 'The OpenAI project reached a rate or usage limit. Check its quota or try again later.' }, 429);
  if (status === 404 || status === 400) return json({ error: 'OpenAI could not process this model request. Check the configured model and its availability.' }, 502);
  return json({ error: 'OpenAI is unavailable. Please retry the step.' }, 502);
}

const notificationTypes = new Set(['ready_for_test', 'needs_approval', 'completed', 'failed']);

function webhookURL(env) {
  if (!env.N8N_WEBHOOK_URL) return null;
  try {
    const url = new URL(env.N8N_WEBHOOK_URL);
    if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function validNotification(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && typeof input.id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.id)
    && notificationTypes.has(input.type)
    && typeof input.jobId === 'string' && input.jobId.length <= 128 && input.jobId.startsWith('job-')
    && typeof input.title === 'string' && input.title.trim() && input.title.length <= 120
    && typeof input.occurredAt === 'string' && Number.isFinite(Date.parse(input.occurredAt))
    && typeof input.detail === 'string' && input.detail.length <= 500;
}

async function notifyN8n(request, env, fetchImpl) {
  if (request.method !== 'POST') return json({ error: 'Use POST for job events.' }, 405);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'A job event requires JSON.' }, 415);
  }
  const target = webhookURL(env);
  if (!target) return json({ error: 'Set N8N_WEBHOOK_URL on the server to enable notifications.' }, 503);
  const token = env.N8N_WEBHOOK_TOKEN?.trim();
  if (!token) return json({ error: 'Set N8N_WEBHOOK_TOKEN on the server to authenticate notifications.' }, 503);
  let event;
  try { event = await readJson(request, 8 * 1024); }
  catch { return json({ error: 'Invalid job event.' }, 400); }
  if (!validNotification(event)) return json({ error: 'Invalid job event.' }, 400);
  const { id, type, jobId, title, occurredAt, detail } = event;
  try {
    const response = await fetchImpl(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentIsland-Token': token },
      body: JSON.stringify({ id, type, jobId, title, occurredAt, detail }), signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    void response.body?.cancel().catch(() => {});
    return response.ok ? json({ delivered: true }) : json({ error: 'n8n rejected the notification.' }, 502);
  } catch { return json({ error: 'Could not reach n8n.' }, 502); }
}

function ollamaBase(env) {
  if (!env.OLLAMA_BASE_URL) return null;
  try {
    const url = new URL(env.OLLAMA_BASE_URL);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function openAIModels(env) {
  const configured = (env.OPENAI_MODELS || env.OPENAI_MODEL || 'gpt-4.1-mini').split(',');
  return [...new Set(configured.map(name => name.trim()).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(name)))];
}

async function ollamaModels(base, fetchImpl) {
  if (!base) return [];
  try {
    const response = await fetchImpl(base + '/api/tags', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) return [];
    const data = await readJson(response, 256 * 1024);
    if (!Array.isArray(data.models)) return [];
    return [...new Set(data.models.filter(item => !Array.isArray(item?.capabilities)
      || item.capabilities.includes('completion')).map(item => item?.name).filter(name =>
      typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(name)))];
  } catch { return []; }
}

// Same handler for the loopback development server and the private Site Worker.
export async function handleAgentRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'Open the Workbench on this island to use the team.' }, 403);
  }
  if (url.pathname === '/api/notifications/event') return notifyN8n(request, env, fetchImpl);
  const key = env.OPENAI_API_KEY?.trim();
  const openModels = openAIModels(env);
  const base = ollamaBase(env);
  if (url.pathname === '/api/agents/status') {
    if (request.method !== 'GET') return json({ error: 'Use GET for team status.' }, 405);
    const localModels = await ollamaModels(base, fetchImpl);
    const providers = [];
    if (localModels.length) providers.push({ id: 'ollama', label: 'Ollama (local)', models: localModels });
    if (key && openModels.length) providers.push({ id: 'openai', label: 'OpenAI', models: openModels });
    return json({ configured: providers.length > 0, providers });
  }
  if (url.pathname !== '/api/agents/step') return json({ error: 'Unknown team endpoint.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST to run a team step.' }, 405);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'A team step requires JSON.' }, 415);
  }
  let step;
  try {
    step = prepareStep(await readJson(request, 256 * 1024));
  } catch (error) {
    if (error instanceof SizeLimitError) return json({ error: 'The team request is too large.' }, 413);
    return json({ error: 'The team request contains invalid JSON.' }, 400);
  }
  if (!step) return json({ error: 'Check the job details and outputs from the preceding team steps.' }, 400);

  const provider = step.provider || 'openai';
  const selectedModel = step.model;
  if (provider !== 'openai' && provider !== 'ollama') return json({ error: 'Choose a configured model provider.' }, 400);
  const localModels = provider === 'ollama' ? await ollamaModels(base, fetchImpl) : [];
  const models = provider === 'openai' && key ? openModels : localModels;
  if (!models.length) return json({ error: provider === 'ollama'
    ? 'No local Ollama models are available. Start Ollama, pull a model, and check again.'
    : 'Set OPENAI_API_KEY on the server or choose an available Ollama model.' }, 503);
  const model = selectedModel || models[0];
  if (!models.includes(model)) return json({ error: 'That model is unavailable. Check the model picker and try again.' }, 400);

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (request.signal.aborted) cancel();
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await fetchImpl(provider === 'openai' ? responsesURL : base + '/api/generate', {
      method: 'POST',
      headers: provider === 'openai'
        ? { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      signal: controller.signal,
      redirect: 'error',
      body: JSON.stringify(provider === 'openai' ? {
        model,
        instructions: step.instructions + ' Work from the supplied job data. You can write and inspect text. Do not claim to have executed code, accessed files, or performed external actions.',
        input: JSON.stringify(step.context),
        store: false,
        max_output_tokens: 2200,
      } : {
        model, stream: true,
        prompt: step.instructions + ' Work from the supplied job data. You can write and inspect text. Do not claim to have executed code, accessed files, or performed external actions.\n\nJob data:\n' + JSON.stringify(step.context),
        options: { num_predict: 2200 },
        ...(['test', 'review', 'helpdesk', 'ideas', 'todos'].includes(step.stage) ? { format: 'json', think: false } : {}),
      }),
    });
    if (!result.ok) {
      void result.body?.cancel().catch(() => {});
      return provider === 'openai' ? providerFailure(result.status)
        : json({ error: 'Ollama could not run this model. Check that it is installed and try again.' }, 502);
    }
    if (provider === 'ollama') {
      let output;
      try { output = await readOllamaStream(result); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (error instanceof SizeLimitError) return json({ error: 'Ollama returned too much text. Try a smaller job.' }, 502);
        return json({ error: 'Ollama did not return a usable text result. Try a smaller job or another model.' }, 502);
      }
      return json({ text: output });
    }
    const answer = await readJson(result, 384 * 1024);
    if (answer.status !== 'completed' || !Array.isArray(answer.output)) {
      return json({ error: 'The model did not finish the step. Try again with a smaller job.' }, 502);
    }
    const text = answer.output
      .filter(item => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
      .flatMap(item => item.content)
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text.trim()).filter(Boolean).join('\n\n');
    if (!text || text.length > maxArtifactLength) return json({ error: 'The model did not return a usable text result. Try a smaller or clearer job.' }, 502);
    return json({ text });
  } catch {
    if (controller.signal.aborted) return json({ error: 'The team request was stopped.' }, 499);
    return json({ error: provider === 'ollama'
      ? 'Could not reach Ollama. Start Ollama and check its local connection.'
      : 'The server could not read a response from OpenAI. Please retry the step.' }, 502);
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}
