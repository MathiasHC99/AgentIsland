/** Local workbench rules. This queue does not execute jobs or connect AI providers. */
export const JOB_PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const JOB_STATUSES = Object.freeze(['available', 'in_progress', 'testing', 'review', 'changes_requested', 'completed']);
export const JOB_LIMITS = Object.freeze({ title: 120, description: 2000, agentName: 60 });
export const CHECK_LIMITS = Object.freeze({ notes: 2000 });
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
  return { version: 2, jobs: [], agents: [], helpRequests: [] };
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
  if (!record(value) || ![1, 2].includes(value.version) || !Array.isArray(value.jobs) || !Array.isArray(value.agents)) return null;
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
