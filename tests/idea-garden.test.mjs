import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobBoard, postJob, saveIdeas, dismissIdea, plantIdea, canBrainstorm,
  serializeJobBoard, restoreJobBoard, setDailyIdeas,
} from '../src/client/domain/jobs.js';
import { parseIdeaResponse, ideaContext } from '../src/client/domain/idea-garden.js';

const proposal = (title, why = 'A small useful addition', doneWhen = 'A clickable result is ready') => ({ title, why, doneWhen });

test('ideas are saved once, survive reload, and can become ordinary jobs', () => {
  const board = createJobBoard();
  postJob(board, { title: 'Weather card' });
  const saved = saveIdeas(board, [proposal('Weather card'), proposal('Tiny calculator'), proposal('tiny calculator!')]);
  assert.equal(saved.ok, true);
  assert.equal(saved.ideas.length, 1);
  assert.equal(board.ideas[0].title, 'Tiny calculator');
  assert.equal(canBrainstorm(board), false);
  assert.equal(setDailyIdeas(board, true).ok, true);
  const restored = restoreJobBoard(serializeJobBoard(board));
  assert.deepEqual(restored, board);
  const planted = plantIdea(restored, restored.ideas[0].id);
  assert.equal(planted.ok, true);
  assert.match(planted.job.description, /Done when: A clickable result is ready/);
  assert.equal(restored.ideas[0].status, 'planted');
  assert.equal(plantIdea(restored, restored.ideas[0].id).ok, false);
  assert.deepEqual(restoreJobBoard(serializeJobBoard(restored)), restored);
});

test('dismissal preserves duplicate history and the cooldown expires', () => {
  const board = createJobBoard();
  const saved = saveIdeas(board, [proposal('Plant guide')]);
  assert.equal(dismissIdea(board, saved.ideas[0].id).ok, true);
  assert.equal(board.ideas[0].status, 'dismissed');
  assert.equal(canBrainstorm(board, Date.parse(board.lastIdeaAt) + 86_400_000), true);
  assert.equal(saveIdeas(board, [proposal('Another')]).reason, 'idea_cooldown');
  board.lastIdeaAt = '2020-01-01T00:00:00.000Z';
  assert.equal(saveIdeas(board, [proposal('plant guide')]).ideas.length, 0);
  assert.equal(board.ideas.length, 1);
});

test('old saved boards migrate and malformed idea data cannot replace existing work', () => {
  const board = createJobBoard();
  postJob(board, { title: 'Keep this job' });
  const old = structuredClone(board);
  delete old.ideas;
  delete old.lastIdeaAt;
  delete old.dailyIdeas;
  const migrated = restoreJobBoard(JSON.stringify(old));
  assert.equal(migrated.jobs[0].title, 'Keep this job');
  assert.deepEqual(migrated.ideas, []);
  assert.equal(migrated.dailyIdeas, false);
  assert.equal(saveIdeas(board, [proposal('A', '', 'Done')]).ok, false);
});

test('the Dreamer response is bounded and board context is short', () => {
  assert.equal(parseIdeaResponse('{"ideas":[{"title":"A","why":"B","doneWhen":"C"}]}').length, 1);
  assert.throws(() => parseIdeaResponse('{"ideas":[]}'));
  assert.throws(() => parseIdeaResponse('not JSON'));
  const board = createJobBoard();
  postJob(board, { title: 'A small game' });
  assert.match(ideaContext(board), /A small game/);
  assert.ok(ideaContext(board, 'x'.repeat(3000)).length <= 2000);
});
