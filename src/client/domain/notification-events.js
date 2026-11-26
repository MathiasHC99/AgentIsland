import { TEAM_AGENT_ID } from './jobs.js';

const eventForStatus = {
  testing: 'ready_for_test',
  review: 'needs_approval',
  completed: 'completed',
  changes_requested: 'failed',
};

export function snapshotJobs(board) {
  return new Map(board.jobs.map(job => [job.id, {
    status: job.status,
    runId: job.teamRun?.id,
    runStatus: job.teamRun?.status,
  }]));
}

/** Only persisted transitions produce notifications. */
export function jobEvents(before, board, makeId = () => crypto.randomUUID()) {
  const events = [];
  for (const job of board.jobs) {
    const previous = before.get(job.id);
    if (!previous) continue;
    if (job.claimedBy === TEAM_AGENT_ID) {
      if (previous.status !== 'completed' && job.status === 'completed') {
        events.push({ id: makeId(), type: 'completed', jobId: job.id, title: job.title,
          occurredAt: new Date().toISOString(), detail: '' });
      }
      continue;
    }
    let type = previous.status !== job.status ? eventForStatus[job.status] : null;
    if (!type && job.teamRun?.status === 'failed'
        && (previous.runStatus !== 'failed' || previous.runId !== job.teamRun.id)
        && !job.teamRun.error.startsWith('Stopped by you.')) type = 'failed';
    if (!type) continue;
    const detail = type === 'failed'
      ? job.teamRun?.status === 'failed' ? job.teamRun.error
        : job.testRuns.at(-1)?.passed === false ? job.testRuns.at(-1).notes
          : job.reviews.at(-1)?.notes || 'The job needs changes.'
      : '';
    events.push({
      id: makeId(), type, jobId: job.id, title: job.title,
      occurredAt: new Date().toISOString(), detail: detail.slice(0, 500),
    });
  }
  return events;
}
