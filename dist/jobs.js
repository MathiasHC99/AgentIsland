/** Local workbench rules. This queue does not execute jobs or connect AI providers. */
export const JOB_PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const JOB_STATUSES = Object.freeze(['available', 'in_progress', 'completed']);
export const JOB_LIMITS = Object.freeze({ title: 120, description: 2000, agentName: 60 });
export const AGENT_STATUSES = Object.freeze(['idle', 'busy', 'relaxing', 'sleeping']);
export const HELP_LIMITS = Object.freeze({ title: 120, details: 2000, author: 60 });

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
  } while (board.jobs.some(job => job.id === id) || board.helpRequests?.some(request => request.id === id));
  return id;
}

export function createJobBoard() {
  return { version: 1, jobs: [], agents: [], helpRequests: [] };
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
  };
  board.jobs.push(job);
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
      || board.jobs.some(item => item.status === 'in_progress' && item.claimedBy === agentId)) {
    return failure('agent_busy', 'This agent already has a job. Finish or return it before picking up another.');
  }
  job.status = 'in_progress';
  job.claimedBy = agent.id;
  job.claimedAt = now();
  agent.status = 'busy';
  agent.jobId = job.id;
  return { ok: true, job, agent };
}

function ownedAssignment(board, jobId, agentId) {
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered at the workbench.');
  const job = board.jobs.find(item => item.id === jobId);
  if (!job) return failure('job_not_found', 'This job is no longer on the board.');
  if (job.status !== 'in_progress') return failure('job_not_in_progress', 'This job is not currently being worked on.');
  if (job.claimedBy !== agent.id || agent.jobId !== job.id || agent.status !== 'busy') {
    return failure('not_job_owner', 'Only the agent working on this job can change its assignment.');
  }
  return { ok: true, job, agent };
}

export function completeJob(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId);
  if (!result.ok) return result;
  result.job.status = 'completed';
  result.job.completedAt = now();
  result.agent.status = 'idle';
  result.agent.jobId = null;
  return result;
}

export function releaseJob(board, jobId, agentId) {
  const result = ownedAssignment(board, jobId, agentId);
  if (!result.ok) return result;
  result.job.status = 'available';
  result.job.claimedBy = null;
  result.job.claimedAt = null;
  result.job.completedAt = null;
  result.agent.status = 'idle';
  result.agent.jobId = null;
  return result;
}

export function summarizeJobs(board) {
  return {
    available: board.jobs.filter(job => job.status === 'available').length,
    inProgress: board.jobs.filter(job => job.status === 'in_progress').length,
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
      || board.jobs.some(job => job.status === 'in_progress' && job.claimedBy === agentId)) {
    return failure('agent_busy', 'Finish or return the current job before taking a break.');
  }
  agent.status = mode;
  return { ok: true, agent };
}

export function wakeAgent(board, agentId) {
  const agent = board.agents.find(item => item.id === agentId);
  if (!agent) return failure('agent_not_found', 'This agent is not registered on the island.');
  if (agent.status === 'busy' || agent.jobId !== null
      || board.jobs.some(job => job.status === 'in_progress' && job.claimedBy === agentId)) {
    return failure('agent_busy', 'This agent is working on a job. Finish or return it first.');
  }
  agent.status = 'idle';
  return { ok: true, agent };
}

export function postHelpRequest(board, input = {}) {
  if (!record(input) || !text(input.title, HELP_LIMITS.title)
      || !text(input.details ?? '', HELP_LIMITS.details, false)
      || !text(input.author ?? 'You', HELP_LIMITS.author)) {
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
  };
  board.helpRequests.push(request);
  return { ok: true, request };
}

export function resolveHelpRequest(board, requestId) {
  const request = board.helpRequests.find(item => item.id === requestId);
  if (!request) return failure('request_not_found', 'This question is no longer at the helpdesk.');
  if (request.status !== 'open') return failure('request_resolved', 'This question has already been resolved.');
  request.status = 'resolved';
  request.resolvedAt = now();
  return { ok: true, request };
}

export function summarizeHelpdesk(board) {
  return {
    open: board.helpRequests.filter(request => request.status === 'open').length,
    resolved: board.helpRequests.filter(request => request.status === 'resolved').length,
    total: board.helpRequests.length,
  };
}

function validatedBoard(value) {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.agents)) return null;
  if (value.helpRequests !== undefined && !Array.isArray(value.helpRequests)) return null;
  const board = createJobBoard();
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
    if (item.status === 'available') {
      if (item.claimedBy !== null || item.claimedAt !== null || item.completedAt !== null) return null;
    } else {
      if (!agents.has(item.claimedBy) || !timestamp(item.claimedAt)
          || Date.parse(item.claimedAt) < Date.parse(item.createdAt)) return null;
      if (item.status === 'in_progress' && item.completedAt !== null) return null;
      if (item.status === 'completed' && (!timestamp(item.completedAt)
          || Date.parse(item.completedAt) < Date.parse(item.claimedAt))) return null;
    }
    const job = {
      id: item.id, title: item.title.trim(), description: item.description.trim(), priority: item.priority,
      status: item.status, claimedBy: item.claimedBy, createdAt: item.createdAt,
      claimedAt: item.claimedAt, completedAt: item.completedAt,
    };
    jobs.set(job.id, job);
    board.jobs.push(job);
  }
  const assigned = new Set();
  for (const job of board.jobs) {
    if (job.status !== 'in_progress') continue;
    const agent = agents.get(job.claimedBy);
    if (assigned.has(agent.id) || agent.status !== 'busy' || agent.jobId !== job.id) return null;
    assigned.add(agent.id);
  }
  for (const agent of board.agents) {
    if (agent.status !== 'busy') continue;
    const job = jobs.get(agent.jobId);
    if (!job || job.status !== 'in_progress' || job.claimedBy !== agent.id) return null;
  }
  const requestIds = new Set();
  for (const item of value.helpRequests ?? []) {
    if (!record(item) || !identifier(item.id) || requestIds.has(item.id) || jobs.has(item.id)
        || !text(item.title, HELP_LIMITS.title) || !text(item.details, HELP_LIMITS.details, false)
        || !text(item.author, HELP_LIMITS.author) || !['open', 'resolved'].includes(item.status)
        || !timestamp(item.createdAt)
        || !(item.resolvedAt === null || timestamp(item.resolvedAt))) return null;
    if (item.status === 'open' && item.resolvedAt !== null) return null;
    if (item.status === 'resolved' && (!timestamp(item.resolvedAt)
        || Date.parse(item.resolvedAt) < Date.parse(item.createdAt))) return null;
    requestIds.add(item.id);
    board.helpRequests.push({
      id: item.id, title: item.title.trim(), details: item.details.trim(), author: item.author.trim(),
      status: item.status, createdAt: item.createdAt, resolvedAt: item.resolvedAt,
    });
  }
  return board;
}

/** Produce a canonical snapshot; inconsistent state cannot be persisted as a valid queue. */
export function serializeJobBoard(board) {
  const valid = validatedBoard(board);
  if (!valid) throw new TypeError('Cannot save an inconsistent workbench job board.');
  return JSON.stringify(valid);
}

/** Storage is untrusted. Bad JSON, unsupported versions, or broken assignments start safely empty. */
export function restoreJobBoard(raw) {
  if (typeof raw !== 'string' || raw.length > 4_000_000) return createJobBoard();
  try { return validatedBoard(JSON.parse(raw)) || createJobBoard(); }
  catch { return createJobBoard(); }
}
