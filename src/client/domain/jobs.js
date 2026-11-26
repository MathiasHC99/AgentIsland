/** Local workbench rules. This queue does not execute jobs or connect AI providers. */
export const JOB_PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const JOB_STATUSES = Object.freeze(['available', 'in_progress', 'testing', 'review', 'changes_requested', 'completed']);
export const JOB_LIMITS = Object.freeze({ title: 120, description: 2000, agentName: 60 });
export const CHECK_LIMITS = Object.freeze({ notes: 2000 });
export const AGENT_STATUSES = Object.freeze(['idle', 'busy', 'relaxing', 'sleeping']);
export const HELP_LIMITS = Object.freeze({ title: 120, details: 2000, author: 60 });
export const IDEA_LIMITS = Object.freeze({ title: 120, why: 360, doneWhen: 360, count: 40, cooldownMs: 86_400_000 });
export const TODO_LIMITS = Object.freeze({ title: 300, details: 1000, count: 300 });
export const TEAM_AGENT_ID = 'island-lead';
export const TEAM_STAGES = Object.freeze(['plan', 'draft', 'check', 'final']);
const TEAM_OUTPUT_LIMIT = 12000;
const BOARD_SAVE_LIMIT = 4_000_000;

let fallbackSequence = 0;
const now = () => new Date().toISOString();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value, maximum, required = true) => typeof value === 'string'
  && value.length <= maximum && (!required || value.trim().length > 0);
const failure = (reason, message) => ({ ok: false, reason, message });

function uniqueId(board, kind = 'job') {
  let id;
  do {
    id = `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
  } while (board.jobs.some(job => job.id === id) || board.helpRequests?.some(request => request.id === id)
    || board.ideas?.some(idea => idea.id === id) || board.todos?.some(todo => todo.id === id));
  return id;
}

export function createJobBoard() {
  return { version: 2, jobs: [], agents: [], helpRequests: [], ideas: [], lastIdeaAt: null, dailyIdeas: false, todos: [] };
}

function seedTodoId(section, title) {
  const value = `${section}:${title}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `todo-seed-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`;
}

function makeTodoRoom(board) {
  if (board.todos.length < TODO_LIMITS.count) return true;
  const removed = board.todos.findIndex(todo => todo.hidden);
  if (removed < 0) return false;
  board.todos.splice(removed, 1);
  return true;
}

export function syncSeedTodos(board, seeds) {
  if (!Array.isArray(seeds)) return failure('invalid_seed', 'The project todo plan could not be read.');
  let added = 0;
  for (const seed of seeds) {
    if (!record(seed) || !text(seed.title, TODO_LIMITS.title) || !text(seed.section, 60)
        || typeof seed.done !== 'boolean') continue;
    const id = seedTodoId(seed.section, seed.title);
    if (board.todos.some(todo => todo.id === id)) continue;
    if (!makeTodoRoom(board)) break;
    board.todos.push({ id, title: seed.title, details: '', source: 'plan', section: seed.section,
      done: seed.done, hidden: false, createdAt: now() });
    added++;
  }
  return { ok: true, added };
}

export function addTodo(board, input = {}) {
  if (!record(input) || !text(input.title, TODO_LIMITS.title)
      || !text(input.details ?? '', TODO_LIMITS.details, false)
      || !['user', 'agent'].includes(input.source)) {
    return failure('invalid_todo', 'Give the todo a title, optional details, and an author.');
  }
  const title = input.title.trim();
  const key = ideaKey(title);
  if (board.todos.some(todo => !todo.hidden && ideaKey(todo.title) === key)) {
    return failure('todo_duplicate', 'This task is already on the noticeboard.');
  }
  if (!makeTodoRoom(board)) return failure('todo_full', 'The noticeboard is full. Remove an old item first.');
  const todo = { id: uniqueId(board, 'todo'), title, details: (input.details ?? '').trim(), source: input.source,
    section: input.source === 'agent' ? 'Agent ideas' : 'Your notes', done: false, hidden: false, createdAt: now() };
  board.todos.push(todo);
  return { ok: true, todo };
}

export function setTodoDone(board, todoId, done) {
  const todo = board.todos.find(item => item.id === todoId && !item.hidden);
  if (!todo || typeof done !== 'boolean') return failure('todo_not_found', 'This task is no longer on the noticeboard.');
  todo.done = done;
  return { ok: true, todo };
}

export function removeTodo(board, todoId) {
  const todo = board.todos.find(item => item.id === todoId && !item.hidden);
  if (!todo) return failure('todo_not_found', 'This task is no longer on the noticeboard.');
  todo.hidden = true;
  return { ok: true, todo };
}

const ideaKey = title => String(title).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function canBrainstorm(board, at = Date.now()) {
  return !board.lastIdeaAt || at - Date.parse(board.lastIdeaAt) >= IDEA_LIMITS.cooldownMs;
}

export function saveIdeas(board, proposals) {
  if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > 3 || proposals.some(idea =>
    !record(idea) || !text(idea.title, IDEA_LIMITS.title) || !text(idea.why, IDEA_LIMITS.why)
    || !text(idea.doneWhen, IDEA_LIMITS.doneWhen))) {
    return failure('invalid_ideas', 'The team did not return one to three usable ideas.');
  }
  if (!canBrainstorm(board)) return failure('idea_cooldown', 'The Idea Garden can brainstorm again tomorrow.');
  const known = new Set([...board.jobs.map(job => ideaKey(job.title)), ...board.ideas.map(idea => ideaKey(idea.title))]);
  const added = [];
  for (const proposal of proposals) {
    const title = proposal.title.trim();
    const key = ideaKey(title);
    if (!key || known.has(key)) continue;
    const oldestInactive = board.ideas.findIndex(idea => idea.status !== 'new');
    if (board.ideas.length >= IDEA_LIMITS.count && oldestInactive >= 0) board.ideas.splice(oldestInactive, 1);
    if (board.ideas.length >= IDEA_LIMITS.count) break;
    const idea = { id: uniqueId(board, 'idea'), title, why: proposal.why.trim(), doneWhen: proposal.doneWhen.trim(),
      status: 'new', createdAt: now(), jobId: null };
    board.ideas.push(idea);
    known.add(key);
    added.push(idea);
  }
  board.lastIdeaAt = now();
  return { ok: true, ideas: added };
}

export function dismissIdea(board, ideaId) {
  const idea = board.ideas.find(item => item.id === ideaId);
  if (!idea || idea.status !== 'new') return failure('idea_unavailable', 'This idea is no longer available.');
  idea.status = 'dismissed';
  return { ok: true, idea };
}

export function plantIdea(board, ideaId) {
  const idea = board.ideas.find(item => item.id === ideaId);
  if (!idea || idea.status !== 'new') return failure('idea_unavailable', 'This idea is no longer available.');
  const created = postJob(board, { title: idea.title, description: `${idea.why}\n\nDone when: ${idea.doneWhen}` });
  if (!created.ok) return created;
  idea.status = 'planted';
  idea.jobId = created.job.id;
  return { ok: true, idea, job: created.job };
}

export function setDailyIdeas(board, enabled) {
  if (typeof enabled !== 'boolean') return failure('invalid_preference', 'Choose whether daily ideas are on or off.');
  board.dailyIdeas = enabled;
  return { ok: true };
}

/** Re-registering a stable identity is safe and never resets its current assignment. */
export function registerAgent(board, input = {}) {
  if (!record(input) || !identifier(input.id) || !text(input.name, JOB_LIMITS.agentName)) {
    return failure('invalid_agent', 'Give the agent a stable ID and a name of 1–60 characters.');
  }
  const existing = board.agents.find(agent => agent.id === input.id);
  if (existing) return { ok: true, agent: existing };
  const agent = { id: input.id, name: input.name.trim(), status: 'idle', jobId: null };
  board.agents.push(agent);
  return { ok: true, agent };
}

export function postJob(board, input = {}) {
  if (!record(input) || !text(input.title, JOB_LIMITS.title)
      || !text(input.description ?? '', JOB_LIMITS.description, false)
      || !JOB_PRIORITIES.includes(input.priority ?? 'normal')) {
    return failure('invalid_job', 'Use a title of 1–120 characters, details up to 2,000 characters, and a valid priority.');
  }
  const job = {
    id: uniqueId(board),
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    priority: input.priority ?? 'normal',
    status: 'available',
    claimedBy: null,
    createdAt: now(),
    claimedAt: null,
    completedAt: null,
    testRuns: [],
    reviews: [],
    legacyCompletion: false,
  };
  board.jobs.push(job);
  return { ok: true, job };
}

/** Remove a job at any stage and release its assigned agent. */
export function deleteJob(board, jobId) {
  const index = board.jobs.findIndex(job => job.id === jobId);
  if (index < 0) return failure('job_not_found', 'This job is no longer on the board.');
  const [job] = board.jobs.splice(index, 1);
  const agent = board.agents.find(item => item.id === job.claimedBy && item.jobId === job.id);
  if (agent) { agent.status = 'idle'; agent.jobId = null; }
  return { ok: true, job };
}

/** Synchronous validation and assignment prevent competing local callers taking one job. */
export function claimJob(board, jobId, agentId) {
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered at the workbench.');
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  if (job.status !== 'available') return failure('job_unavailable', 'Another agent has already picked up this job.');
  if (agent.status === 'relaxing' || agent.status === 'sleeping') {
    return failure('agent_resting', 'This agent is taking a break at the spa. Wake it before picking up a job.');
  }
  if (agent.status !== 'idle' || agent.jobId !== null
      || board.jobs.some(item => ACTIVE_JOB_STATUSES.has(item.status) && item.claimedBy === agentId)) {
    return failure('agent_busy', 'This agent already has a job. Finish or return it before picking up another.');
  }
  job.status = 'in_progress';
  job.claimedBy = agent.id;
  job.claimedAt = now();
  agent.status = 'busy';
  agent.jobId = job.id;
  return { ok: true, job, agent };
}

const ACTIVE_JOB_STATUSES = new Set(['in_progress', 'testing', 'review', 'changes_requested']);

function ownedAssignment(board, jobId, agentId, allowedStatuses = ['in_progress']) {
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered at the workbench.');
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  if (!allowedStatuses.includes(job.status)) return failure('job_not_in_progress', 'This job is not in the required stage.');
  if (job.claimedBy !== agent.id || agent.jobId !== job.id || agent.status !== 'busy') {
    return failure('not_job_owner', 'Only the agent working on this job can change its assignment.');
  }
  return { ok: true, job, agent };
}

export function completeJob(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId, [...ACTIVE_JOB_STATUSES]);
  if (!result.ok) return result;
  return failure('review_required', 'Approve this job at the review station to complete it.');
}

export function releaseJob(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId, ['in_progress', 'changes_requested']);
  if (!result.ok) return result;
  if (result.job.teamRun?.status === 'running') {
    return failure('team_running', 'Stop the team before returning this job.');
  }
  result.job.status = 'available';
  result.job.claimedBy = null;
  result.job.claimedAt = null;
  result.job.completedAt = null;
  result.agent.status = 'idle';
  result.agent.jobId = null;
  return result;
}

/** The assigned agent hands work to the test station without freeing the assignment. */
export function submitJobForTesting(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId);
  if (!result.ok) return result;
  if (agentId === TEAM_AGENT_ID && result.job.teamRun) {
    return failure('team_result_required', 'The team must finish its result before submitting the job.');
  }
  result.job.status = 'testing';
  return result;
}

/** A manual test run records evidence and routes the job to review or changes. */
export function recordTestResult(board, jobId, input = {}) {
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  if (job.status !== 'testing') return failure('job_not_testing', 'Submit this job for testing first.');
  if (!record(input) || typeof input.passed !== 'boolean'
      || !text(input.notes ?? '', CHECK_LIMITS.notes, false)
      || (!input.passed && !(input.notes ?? '').trim())) {
    return failure('invalid_test_result', 'Choose pass or fail and add notes for a failure (up to 2,000 characters).');
  }
  const testRun = { passed: input.passed, notes: (input.notes ?? '').trim(), createdAt: now() };
  job.testRuns.push(testRun);
  job.status = testRun.passed ? 'review' : 'changes_requested';
  return { ok: true, job, testRun };
}

/** An approval is the only path from review to completion. */
export function recordReviewDecision(board, jobId, input = {}) {
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  if (job.status !== 'review') return failure('job_not_in_review', 'This job needs a passing test before review.');
  if (!record(input) || typeof input.approved !== 'boolean'
      || !text(input.notes ?? '', CHECK_LIMITS.notes, false)
      || (!input.approved && !(input.notes ?? '').trim())) {
    return failure('invalid_review', 'Choose approval or changes and add feedback when requesting changes (up to 2,000 characters).');
  }
  const review = { approved: input.approved, notes: (input.notes ?? '').trim(), createdAt: now() };
  job.reviews.push(review);
  if (review.approved) {
    job.status = 'completed';
    job.completedAt = review.createdAt;
    const agent = board.agents.find(item => item.id === job.claimedBy);
    agent.status = 'idle';
    agent.jobId = null;
  } else job.status = 'changes_requested';
  return { ok: true, job, review };
}

/** The assigned agent may revise a failed test or a declined review. */
export function resumeJob(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId, ['changes_requested']);
  if (!result.ok) return result;
  result.job.status = 'in_progress';
  return result;
}

/** A new run claims work, revises a submission, or continues the saved steps of a failed attempt. */
export function startTeamRun(board, jobId, runId) {
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  const previous = job.teamRun;
  if (!identifier(runId) || previous?.id === runId) {
    return failure('invalid_run_id', 'Each attempt needs a fresh run ID.');
  }
  let assignment;
  if (job.status === 'available') {
    // Only register the lead after checking the job can be claimed.
    registerAgent(board, { id: TEAM_AGENT_ID, name: 'Island lead' });
    assignment = claimJob(board, jobId, TEAM_AGENT_ID);
  } else if (job.status === 'changes_requested') {
    assignment = resumeJob(board, jobId, TEAM_AGENT_ID);
  } else if (job.status === 'in_progress' && previous?.status === 'failed') {
    assignment = ownedAssignment(board, jobId, TEAM_AGENT_ID);
  } else {
    return failure('job_unavailable', 'Choose an available job, a failed attempt, or a job returned for changes.');
  }
  if (!assignment.ok) return assignment;

  if (previous?.status === 'failed') {
    job.teamRun = { ...previous, id: runId, status: 'running', error: '' };
  } else {
    job.teamRun = {
      id: runId, status: 'running', plan: '', draft: '', check: '', final: '', error: '',
      previousFinal: previous?.final || '',
    };
  }
  return assignment;
}

function activeTeamRun(board, jobId, runId) {
  const assignment = ownedAssignment(board, jobId, TEAM_AGENT_ID);
  if (!assignment.ok) return assignment;
  const run = assignment.job.teamRun;
  if (run?.id !== runId || run?.status !== 'running') {
    return failure('run_changed', 'This attempt is no longer running.');
  }
  return assignment;
}

export function saveTeamStep(board, jobId, runId, stage, output) {
  const assignment = activeTeamRun(board, jobId, runId);
  if (!assignment.ok) return assignment;
  const run = assignment.job.teamRun;
  if (!TEAM_STAGES.includes(stage) || TEAM_STAGES.find(key => !run[key]) !== stage) {
    return failure('unexpected_step', 'This step has already finished or is waiting for an earlier step.');
  }
  if (!text(output, TEAM_OUTPUT_LIMIT)) {
    return failure('invalid_output', 'The model must return between 1 and 12,000 characters.');
  }
  run[stage] = output.trim();
  if (stage === 'final') {
    run.status = 'submitted';
    assignment.job.status = 'testing';
  }
  return assignment;
}

export function stopTeamRun(board, jobId, runId, message = 'Stopped by the user.') {
  const assignment = activeTeamRun(board, jobId, runId);
  if (!assignment.ok) return assignment;
  const run = assignment.job.teamRun;
  run.status = 'failed';
  run.error = typeof message === 'string' && message.trim()
    ? message.trim().slice(0, 500) : 'The run was interrupted.';
  return assignment;
}

export function summarizeJobs(board) {
  return {
    available: board.jobs.filter(job => job.status === 'available').length,
    inProgress: board.jobs.filter(job => job.status === 'in_progress').length,
    testing: board.jobs.filter(job => job.status === 'testing').length,
    review: board.jobs.filter(job => job.status === 'review').length,
    changesRequested: board.jobs.filter(job => job.status === 'changes_requested').length,
    completed: board.jobs.filter(job => job.status === 'completed').length,
    total: board.jobs.length,
    idleAgents: board.agents.filter(agent => agent.status === 'idle').length,
    busyAgents: board.agents.filter(agent => agent.status === 'busy').length,
  };
}

/** Rest is a real availability state, never a way to abandon an assigned job. */
export function setAgentRest(board, agentId, mode = 'relaxing') {
  if (!['relaxing', 'sleeping'].includes(mode)) return failure('invalid_rest_mode', 'Choose relaxing or sleeping.');
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered on the island.');
  if (agent.status === 'busy' || agent.jobId !== null
      || board.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status) && job.claimedBy === agentId)) {
    return failure('agent_busy', 'Finish or return the current job before taking a break.');
  }
  agent.status = mode;
  return { ok: true, agent };
}

export function wakeAgent(board, agentId) {
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered on the island.');
  if (agent.status === 'busy' || agent.jobId !== null
      || board.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status) && job.claimedBy === agentId)) {
    return failure('agent_busy', 'This agent is working on a job. Finish or return it first.');
  }
  agent.status = 'idle';
  return { ok: true, agent };
}

export function postHelpRequest(board, input = {}) {
  if (!record(input) || !text(input.title, HELP_LIMITS.title)
      || !text(input.details ?? '', HELP_LIMITS.details, false)
      || !text(input.author ?? 'You', HELP_LIMITS.author)
      || !(input.jobId === undefined || identifier(input.jobId))) {
    return failure('invalid_help_request', 'Use a title of 1–120 characters, details up to 2,000 characters, and a name of 1–60 characters.');
  }
  const request = {
    id: uniqueId(board, 'help'),
    title: input.title.trim(),
    details: (input.details ?? '').trim(),
    author: (input.author ?? 'You').trim(),
    status: 'open',
    createdAt: now(),
    resolvedAt: null,
    jobId: input.jobId ?? null,
    helperStatus: 'queued',
    helperNote: '',
    resumeOnAnswer: input.resumeOnAnswer !== false,
  };
  board.helpRequests.push(request);
  return { ok: true, request };
}

export function claimAgentHelp(board, requestId) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request || request.status !== 'open' || request.helperStatus !== 'queued') {
    return failure('help_unavailable', 'This Helpdesk request is no longer queued.');
  }
  if (board.helpRequests.some(item => item.status === 'open' && item.helperStatus === 'working')) {
    return failure('helper_busy', 'The Helpdesk agent is already helping another request.');
  }
  const next = board.helpRequests.find(item => item.status === 'open' && item.helperStatus === 'queued');
  if (next?.id !== requestId) return failure('help_waiting', 'An earlier Helpdesk request is ahead in the queue.');
  request.helperStatus = 'working';
  return { ok: true, request };
}

export function finishAgentHelp(board, requestId, answer) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request || request.status !== 'open' || request.helperStatus !== 'working') {
    return failure('help_unavailable', 'This Helpdesk request is no longer being handled.');
  }
  if (!record(answer) || typeof answer.resolved !== 'boolean' || !text(answer.guidance, 1500)) {
    return failure('invalid_help_answer', 'The helper must provide a clear answer.');
  }
  request.helperNote = answer.guidance.trim();
  request.helperStatus = answer.resolved ? 'answered' : 'needs_human';
  if (answer.resolved) {
    request.status = 'resolved';
    request.resolvedAt = now();
  }
  return { ok: true, request };
}

export function cancelAgentHelp(board, requestId) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request || request.helperStatus !== 'working') return failure('help_unavailable', 'This Helpdesk request is no longer being handled.');
  request.helperStatus = 'cancelled';
  return { ok: true, request };
}

export function requeueAgentHelp(board, requestId) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request || request.status !== 'open' || !['working', 'needs_human', 'cancelled'].includes(request.helperStatus)) {
    return failure('help_unavailable', 'This Helpdesk request cannot be retried.');
  }
  request.helperStatus = 'queued';
  request.helperNote = '';
  return { ok: true, request };
}

export function resolveHelpRequest(board, requestId) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request) return failure('request_not_found', 'This question is no longer at the helpdesk.');
  if (request.status !== 'open') return failure('request_resolved', 'This question has already been resolved.');
  if (request.helperStatus === 'working') return failure('helper_working', 'The Helpdesk agent is still working on this question.');
  request.status = 'resolved';
  request.resolvedAt = now();
  if (request.helperStatus === 'queued') request.helperStatus = 'cancelled';
  return { ok: true, request };
}

export function summarizeHelpdesk(board) {
  return {
    open: board.helpRequests.filter(request => request.status === 'open').length,
    resolved: board.helpRequests.filter(request => request.status === 'resolved').length,
    total: board.helpRequests.length,
  };
}

function readTeamRun(value, job) {
  if (!record(value) || !identifier(value.id) || !['running', 'failed', 'submitted'].includes(value.status)
      || !text(value.error, 500, false) || !text(value.previousFinal, TEAM_OUTPUT_LIMIT, false)) return null;
  const run = { id: value.id, status: value.status, error: value.error.trim(), previousFinal: value.previousFinal.trim() };
  let missing = false;
  for (const step of TEAM_STAGES) {
    if (!text(value[step], TEAM_OUTPUT_LIMIT, false)) return null;
    run[step] = value[step].trim();
    if (missing && run[step]) return null;
    if (!run[step]) missing = true;
  }
  if ((run.status === 'submitted') !== Boolean(run.final)) return null;
  if ((run.status === 'failed') !== Boolean(run.error)) return null;
  if (run.status === 'running' && (job.status !== 'in_progress' || job.claimedBy !== TEAM_AGENT_ID)) return null;
  return run;
}

function validatedBoard(value) {
  if (!record(value) || ![1, 2].includes(value.version) || !Array.isArray(value.jobs) || !Array.isArray(value.agents)) return null;
  if (value.helpRequests !== undefined && !Array.isArray(value.helpRequests)) return null;
  if (value.ideas !== undefined && !Array.isArray(value.ideas)) return null;
  if (value.lastIdeaAt !== undefined && value.lastIdeaAt !== null && !timestamp(value.lastIdeaAt)) return null;
  if (value.dailyIdeas !== undefined && typeof value.dailyIdeas !== 'boolean') return null;
  if (value.todos !== undefined && !Array.isArray(value.todos)) return null;
  const board = createJobBoard();
  board.lastIdeaAt = value.lastIdeaAt ?? null;
  board.dailyIdeas = value.dailyIdeas ?? false;
  const agents = new Map();
  const jobs = new Map();
  for (const item of value.agents) {
    if (!record(item) || !identifier(item.id) || agents.has(item.id)
        || !text(item.name, JOB_LIMITS.agentName)
        || !AGENT_STATUSES.includes(item.status)
        || !(item.jobId === null || identifier(item.jobId))) return null;
    if ((item.status !== 'busy') !== (item.jobId === null)) return null;
    const agent = { id: item.id, name: item.name.trim(), status: item.status, jobId: item.jobId };
    agents.set(agent.id, agent);
    board.agents.push(agent);
  }
  for (const item of value.jobs) {
    if (!record(item) || !identifier(item.id) || jobs.has(item.id)
        || !text(item.title, JOB_LIMITS.title)
        || !text(item.description, JOB_LIMITS.description, false)
        || !JOB_PRIORITIES.includes(item.priority) || !JOB_STATUSES.includes(item.status)
        || !timestamp(item.createdAt)
        || !(item.claimedAt === null || timestamp(item.claimedAt))
        || !(item.completedAt === null || timestamp(item.completedAt))
        || !(item.claimedBy === null || identifier(item.claimedBy))) return null;
    const legacy = value.version === 1;
    if (legacy && !['available', 'in_progress', 'completed'].includes(item.status)) return null;
    if (!legacy && (!Array.isArray(item.testRuns) || !Array.isArray(item.reviews)
        || typeof item.legacyCompletion !== 'boolean')) return null;
    const testRuns = legacy ? [] : item.testRuns;
    const reviews = legacy ? [] : item.reviews;
    if (!testRuns.every(run => record(run) && typeof run.passed === 'boolean'
        && text(run.notes, CHECK_LIMITS.notes, false)
        && (run.passed || !!run.notes.trim())
        && timestamp(run.createdAt) && Date.parse(run.createdAt) >= Date.parse(item.createdAt))) return null;
    if (!reviews.every(review => record(review) && typeof review.approved === 'boolean'
        && text(review.notes, CHECK_LIMITS.notes, false)
        && (review.approved || !!review.notes.trim())
        && timestamp(review.createdAt) && Date.parse(review.createdAt) >= Date.parse(item.createdAt))) return null;
    const lastTest = testRuns.at(-1);
    const lastReview = reviews.at(-1);
    const legacyCompletion = legacy ? item.status === 'completed' : item.legacyCompletion;
    if (legacyCompletion && (item.status !== 'completed' || testRuns.length || reviews.length)) return null;
    if (item.status === 'review' && !lastTest?.passed) return null;
    if (item.status === 'changes_requested' && lastTest?.passed !== false && lastReview?.approved !== false) return null;
    if (item.status === 'completed' && !legacyCompletion && (!lastTest?.passed || !lastReview?.approved)) return null;
    if (item.status === 'available') {
      if (item.claimedBy !== null || item.claimedAt !== null || item.completedAt !== null) return null;
    } else {
      if (!agents.has(item.claimedBy) || !timestamp(item.claimedAt)
          || Date.parse(item.claimedAt) < Date.parse(item.createdAt)) return null;
      if (ACTIVE_JOB_STATUSES.has(item.status) && item.completedAt !== null) return null;
      if (item.status === 'completed' && (!timestamp(item.completedAt)
          || Date.parse(item.completedAt) < Date.parse(item.claimedAt))) return null;
    }
    const job = {
      id: item.id, title: item.title.trim(), description: item.description.trim(), priority: item.priority,
      status: item.status, claimedBy: item.claimedBy, createdAt: item.createdAt,
      claimedAt: item.claimedAt, completedAt: item.completedAt,
      testRuns: testRuns.map(run => ({ passed: run.passed, notes: run.notes.trim(), createdAt: run.createdAt })),
      reviews: reviews.map(review => ({ approved: review.approved, notes: review.notes.trim(), createdAt: review.createdAt })),
      legacyCompletion,
    };
    if (!legacy && item.teamRun !== undefined) {
      job.teamRun = readTeamRun(item.teamRun, job);
      if (!job.teamRun) return null;
    }
    jobs.set(job.id, job);
    board.jobs.push(job);
  }
  const assigned = new Set();
  for (const job of board.jobs) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    const agent = agents.get(job.claimedBy);
    if (assigned.has(agent.id) || agent.status !== 'busy' || agent.jobId !== job.id) return null;
    assigned.add(agent.id);
  }
  for (const agent of board.agents) {
    if (agent.status !== 'busy') continue;
    const job = jobs.get(agent.jobId);
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status) || job.claimedBy !== agent.id) return null;
  }
  const requestIds = new Set();
  for (const item of value.helpRequests ?? []) {
    if (!record(item) || !identifier(item.id) || requestIds.has(item.id) || jobs.has(item.id)
        || !text(item.title, HELP_LIMITS.title) || !text(item.details, HELP_LIMITS.details, false)
        || !text(item.author, HELP_LIMITS.author) || !['open', 'resolved'].includes(item.status)
        || !timestamp(item.createdAt)
        || !(item.resolvedAt === null || timestamp(item.resolvedAt))
        || !(item.jobId === undefined || item.jobId === null || identifier(item.jobId))
        || !(item.helperStatus === undefined || ['none', 'queued', 'working', 'answered', 'needs_human', 'cancelled'].includes(item.helperStatus))
        || !(item.resumeOnAnswer === undefined || typeof item.resumeOnAnswer === 'boolean')
        || !(item.helperNote === undefined || text(item.helperNote, 1500, false))) return null;
    if (item.status === 'open' && item.resolvedAt !== null) return null;
    if (item.status === 'resolved' && (!timestamp(item.resolvedAt)
        || Date.parse(item.resolvedAt) < Date.parse(item.createdAt))) return null;
    requestIds.add(item.id);
    board.helpRequests.push({
      id: item.id, title: item.title.trim(), details: item.details.trim(), author: item.author.trim(),
      status: item.status, createdAt: item.createdAt, resolvedAt: item.resolvedAt,
      jobId: item.jobId ?? null,
      helperStatus: item.status === 'open' && (!item.helperStatus || item.helperStatus === 'none') ? 'queued' : item.helperStatus,
      helperNote: (item.helperNote ?? '').trim(),
      resumeOnAnswer: item.resumeOnAnswer ?? true,
    });
  }
  if ((value.ideas?.length ?? 0) > IDEA_LIMITS.count) return null;
  const ideaIds = new Set();
  for (const item of value.ideas ?? []) {
    if (!record(item) || !identifier(item.id) || ideaIds.has(item.id) || jobs.has(item.id) || requestIds.has(item.id)
        || !text(item.title, IDEA_LIMITS.title) || !text(item.why, IDEA_LIMITS.why)
        || !text(item.doneWhen, IDEA_LIMITS.doneWhen) || !['new', 'dismissed', 'planted'].includes(item.status)
        || !timestamp(item.createdAt) || !(item.jobId === null || identifier(item.jobId))
        || (item.status === 'planted') !== (item.jobId !== null)) return null;
    ideaIds.add(item.id);
    board.ideas.push({ id: item.id, title: item.title.trim(), why: item.why.trim(), doneWhen: item.doneWhen.trim(),
      status: item.status, createdAt: item.createdAt, jobId: item.jobId });
  }
  if ((value.todos?.length ?? 0) > TODO_LIMITS.count) return null;
  const todoIds = new Set();
  for (const item of value.todos ?? []) {
    if (!record(item) || !identifier(item.id) || todoIds.has(item.id) || jobs.has(item.id)
        || requestIds.has(item.id) || ideaIds.has(item.id) || !text(item.title, TODO_LIMITS.title)
        || !text(item.details, TODO_LIMITS.details, false) || !['plan', 'user', 'agent'].includes(item.source)
        || !text(item.section, 60) || typeof item.done !== 'boolean' || typeof item.hidden !== 'boolean'
        || !timestamp(item.createdAt)) return null;
    todoIds.add(item.id);
    board.todos.push({ id: item.id, title: item.title.trim(), details: item.details.trim(), source: item.source,
      section: item.section.trim(), done: item.done, hidden: item.hidden, createdAt: item.createdAt });
  }
  return board;
}

/** Produce a canonical snapshot; inconsistent state cannot be persisted as a valid queue. */
export function serializeJobBoard(board) {
  const valid = validatedBoard(board);
  if (!valid) throw new TypeError('Cannot save an inconsistent workbench job board.');
  const snapshot = JSON.stringify(valid);
  if (snapshot.length > BOARD_SAVE_LIMIT) throw new RangeError('This board exceeds the local save limit.');
  return snapshot;
}

/** Storage is untrusted. Bad JSON, unsupported versions, or broken assignments start safely empty. */
export function restoreJobBoard(raw) {
  if (typeof raw !== 'string' || raw.length > BOARD_SAVE_LIMIT) return createJobBoard();
  try { return validatedBoard(JSON.parse(raw)) || createJobBoard(); }
  catch { return createJobBoard(); }
}
