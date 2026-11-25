const responsesURL = 'https://api.openai.com/v1/responses';
const maxArtifactLength = 12_000;
const stages = {
  plan: {
    requires: [],
    instructions: 'You are the Island Lead. Give your Writer a short, concrete assignment for the requested deliverable. Give your Checker clear acceptance criteria. Include any requested revisions.',
  },
  draft: {
    requires: ['plan'],
    instructions: 'You are the Writer working for the Island Lead. Carry out the writing assignment in the plan and produce the requested draft itself. Use the job requirements and incorporate any revision feedback.',
  },
  check: {
    requires: ['plan', 'draft'],
    instructions: 'You are the Checker working for the Island Lead. Check the actual draft against the job and the acceptance criteria in the plan. Give specific findings, corrections and unverified claims for the Lead. Describe only checks you can perform on the supplied text.',
  },
  final: {
    requires: ['plan', 'draft', 'check'],
    instructions: 'You are the Island Lead. Combine the Writer’s draft and the Checker’s findings to produce the final deliverable requested in the job. Resolve the feedback. Return the deliverable itself in the requested format, ready for a human to test.',
  },
};

const limits = {
  title: 120, description: 2_000, plan: maxArtifactLength, draft: maxArtifactLength,
  check: maxArtifactLength, previous: maxArtifactLength, feedback: 4_000,
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

function prepareStep(input) {
  if (!input || typeof input.stage !== 'string' || !Object.hasOwn(stages, input.stage)) return null;
  const stage = stages[input.stage];
  const context = {};
  for (const field of ['title', 'description', 'previous', 'feedback', ...stage.requires]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > limits[field]) return null;
    if (!value.trim() && (field === 'title' || stage.requires.includes(field))) return null;
    if (value.trim()) context[field] = value.trim();
  }
  return { instructions: stage.instructions, context };
}

function providerFailure(status) {
  if (status === 401 || status === 403) return json({ error: 'OpenAI denied access. Check the server API key and its model permissions.' }, 502);
  if (status === 429) return json({ error: 'The OpenAI project reached a rate or usage limit. Check its quota or try again later.' }, 429);
  if (status === 404 || status === 400) return json({ error: 'OpenAI could not process this model request. Check the configured model and its availability.' }, 502);
  return json({ error: 'OpenAI is unavailable. Please retry the step.' }, 502);
}

// Same handler for the loopback development server and the private Site Worker.
export async function handleAgentRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'Open the Workbench on this island to use the team.' }, 403);
  }
  const key = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
  if (url.pathname === '/api/agents/status') {
    if (request.method !== 'GET') return json({ error: 'Use GET for team status.' }, 405);
    return json({ configured: Boolean(key), model });
  }
  if (url.pathname !== '/api/agents/step') return json({ error: 'Unknown team endpoint.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST to run a team step.' }, 405);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'A team step requires JSON.' }, 415);
  }
  if (!key) return json({ error: 'Set OPENAI_API_KEY on the server to connect the AI team.' }, 503);
  let step;
  try {
    step = prepareStep(await readJson(request, 256 * 1024));
  } catch (error) {
    if (error instanceof SizeLimitError) return json({ error: 'The team request is too large.' }, 413);
    return json({ error: 'The team request contains invalid JSON.' }, 400);
  }
  if (!step) return json({ error: 'Check the job details and outputs from the preceding team steps.' }, 400);

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (request.signal.aborted) cancel();
  request.signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 90_000);
  try {
    const result = await fetchImpl(responsesURL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      signal: controller.signal,
      redirect: 'error',
      body: JSON.stringify({
        model,
        instructions: step.instructions + ' Work from the supplied job data. You can write and inspect text. Do not claim to have executed code, accessed files, or performed external actions.',
        input: JSON.stringify(step.context),
        store: false,
        max_output_tokens: 2200,
      }),
    });
    if (!result.ok) {
      void result.body?.cancel().catch(() => {});
      return providerFailure(result.status);
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
    if (controller.signal.aborted) return json({ error: 'The team request was stopped or timed out.' }, 504);
    return json({ error: 'The server could not read a response from OpenAI. Please retry the step.' }, 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', cancel);
  }
}
