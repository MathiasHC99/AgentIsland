import {
  TEAM_STAGES, startTeamRun, saveTeamStep, stopTeamRun,
  recordTestResult, recordReviewDecision, postHelpRequest, cancelAgentHelp, resolveHelpRequest,
  addTodo,
} from '../domain/jobs.js';
import { parseDecision } from './autonomous-check.js';

const short = value => String(value || '').trim().slice(0, 1500);

function revisionNotes(job) {
  const test = job.testRuns.at(-1);
  if (test && !test.passed) return test.notes;
  const review = job.reviews.at(-1);
  return review && !review.approved ? review.notes : '';
}

/** One bounded attempt at a job, including agent checks and Helpdesk repair. */
export async function runAutonomousJob({
  store, jobId, callStep, smokeTest, notifyHuman = () => {}, onProgress = () => {},
  signal = new AbortController().signal, newRunId = () => crypto.randomUUID(), maxRevisions = 1,
  initialFeedback = '',
}) {
  let extraFeedback = short(initialFeedback);
  let currentJob;
  const mutate = action => store.mutate(action);

  async function help(issue, job) {
    let request;
    try {
      const posted = await mutate(board => postHelpRequest(board, {
        title: `Agent help: ${job.title}`.slice(0, 120),
        details: `Issue: ${short(issue)}`.slice(0, 2000),
        author: 'Island lead', jobId: job.id, resumeOnAnswer: false,
      }));
      if (!posted.ok) throw new Error(posted.message);
      request = posted.request;
    } catch (error) {
      return { resolved: false, guidance: 'The Helpdesk could not accept the request: ' + short(error.message) };
    }
    onProgress('The request is queued for the Helpdesk agent.');
    const answer = await new Promise(resolve => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = value => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener('abort', stopped);
        resolve(value);
      };
      const stopped = () => finish(null);
      const check = board => {
        const current = board.helpRequests.find(item => item.id === request.id);
        if (!current) return finish({ resolved: false, guidance: 'The Helpdesk request disappeared.' });
        if (current.helperStatus === 'working') onProgress('The Helpdesk agent is diagnosing the issue.');
        if (current.helperStatus === 'answered') finish({ resolved: true, guidance: current.helperNote });
        else if (current.helperStatus === 'needs_human' || current.helperStatus === 'cancelled') {
          finish({ resolved: false, guidance: current.helperNote || 'The Helpdesk request was stopped.' });
        }
      };
      unsubscribe = store.subscribe(check);
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) stopped();
      else check(store.getBoard());
    });
    if (signal.aborted) {
      try { await mutate(board => {
        const current = board.helpRequests.find(item => item.id === request.id);
        return current?.helperStatus === 'queued'
          ? resolveHelpRequest(board, request.id) : cancelAgentHelp(board, request.id);
      }); } catch { /* The stopped run will not use the answer. */ }
      return null;
    }
    return answer;
  }

  async function escalate(issue, job) {
    const detail = short(issue).slice(0, 500);
    try {
      await mutate(board => addTodo(board, {
        title: `Investigate ${job.title}`.slice(0, 300), details: detail,
        source: 'agent',
      }));
    } catch { /* A full noticeboard must not prevent the alert. */ }
    try {
      await notifyHuman({
        id: crypto.randomUUID(), type: 'failed', jobId: job.id, title: job.title,
        occurredAt: new Date().toISOString(), detail,
      });
    } catch { /* The job still needs attention if notification delivery fails. */ }
    onProgress('The team needs your help. Check the Helpdesk and the job.', true);
    return { status: 'needs_human', job, reason: detail };
  }

  async function handleIssue(issue, job, attempt, reject) {
    onProgress('The Helpdesk is diagnosing the issue.');
    const answer = await help(issue, job);
    if (signal.aborted) return { status: 'stopped', job };
    if (answer?.resolved && attempt < maxRevisions) {
      if (reject) {
        const result = await mutate(reject);
        if (!result.ok) return escalate(result.message, job);
      }
      extraFeedback = `${short(issue)}\nHelpdesk guidance: ${answer.guidance}`;
      onProgress('The Helpdesk found a correction. The team is revising the job.');
      return null;
    }
    return escalate(`${short(issue)} ${answer?.guidance || ''}`, job);
  }

  for (let attempt = 0; attempt <= maxRevisions; attempt++) {
    if (signal.aborted) return { status: 'stopped', job: currentJob };
    const runId = newRunId();
    const started = await mutate(board => startTeamRun(board, jobId, runId));
    if (!started.ok) return { status: 'failed_to_start', reason: started.message };
    currentJob = started.job;
    try {
      for (const stage of TEAM_STAGES) {
        if (signal.aborted) return { status: 'stopped', job: currentJob };
        if (currentJob.teamRun[stage]) continue;
        onProgress(`${stage === 'final' ? 'Lead' : stage === 'draft' ? 'Writer' : stage === 'check' ? 'Checker' : 'Lead'} is working.`);
        const { plan, draft, check, previousFinal } = currentJob.teamRun;
        const text = await callStep({
          stage, title: currentJob.title, description: currentJob.description,
          plan, draft, check, previous: previousFinal,
          feedback: [revisionNotes(currentJob), extraFeedback].filter(Boolean).join('\n'),
        });
        if (signal.aborted) return { status: 'stopped', job: currentJob };
        const saved = await mutate(board => saveTeamStep(board, jobId, runId, stage, text));
        if (!saved.ok) throw new Error(saved.message);
        currentJob = saved.job;
      }
    } catch (error) {
      if (signal.aborted) return { status: 'stopped', job: currentJob };
      const issue = short(error.message || 'Model step failed.');
      const stopped = await mutate(board => stopTeamRun(board, jobId, runId, issue));
      if (!stopped.ok) return escalate(issue, currentJob);
      currentJob = stopped.job;
      const result = await handleIssue(issue, currentJob, attempt);
      if (result) return result;
      continue;
    }

    onProgress('Agent Tester is checking the result.');
    let test;
    try {
      const smoke = await smokeTest(currentJob);
      const text = await callStep({
        stage: 'test', title: currentJob.title, description: currentJob.description,
        final: currentJob.teamRun.final, smoke,
      });
      test = parseDecision(text, 'test');
      if (smoke.startsWith('FAIL:')) test = { passed: false, needsHuman: false, notes: smoke + ' ' + test.notes };
    } catch (error) {
      if (signal.aborted) return { status: 'stopped', job: currentJob };
      test = { passed: false, needsHuman: true, notes: 'Agent testing could not finish: ' + short(error.message) };
    }
    if (!test.passed || test.needsHuman) {
      const issue = short(test.notes);
      const result = await handleIssue(issue, currentJob, attempt,
        board => recordTestResult(board, jobId, { passed: false, notes: issue }));
      if (result) return result;
      continue;
    }
    const tested = await mutate(board => recordTestResult(board, jobId, { passed: true, notes: short(test.notes) }));
    if (!tested.ok) return escalate(tested.message, currentJob);
    currentJob = tested.job;

    onProgress('Agent Reviewer is checking the evidence.');
    let review;
    try {
      const text = await callStep({
        stage: 'review', title: currentJob.title, description: currentJob.description,
        final: currentJob.teamRun.final, testReport: short(test.notes),
      });
      review = parseDecision(text, 'review');
    } catch (error) {
      if (signal.aborted) return { status: 'stopped', job: currentJob };
      review = { approved: false, needsHuman: true, notes: 'Agent review could not finish: ' + short(error.message) };
    }
    if (!review.approved || review.needsHuman) {
      const issue = short(review.notes);
      const result = await handleIssue(issue, currentJob, attempt,
        board => recordReviewDecision(board, jobId, { approved: false, notes: issue }));
      if (result) return result;
      continue;
    }
    const approved = await mutate(board => recordReviewDecision(board, jobId, { approved: true, notes: short(review.notes) }));
    if (!approved.ok) return escalate(approved.message, currentJob);
    onProgress('The team finished and approved the job.');
    return { status: 'completed', job: approved.job };
  }
  return { status: 'needs_human', job: currentJob };
}
