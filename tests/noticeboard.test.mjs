import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobBoard, addTodo, syncSeedTodos, setTodoDone, removeTodo,
  serializeJobBoard, restoreJobBoard, postJob } from '../src/client/domain/jobs.js';
import { parseTodoResponse, todoContext } from '../src/client/ui/noticeboard-ui.js';

test('project plan seeds once and user changes survive reload', () => {
  const board = createJobBoard();
  const seeds = [
    { section: 'Your requests', title: 'Show the todo list on the island', done: false },
    { section: 'My ideas', title: 'Celebrate finished jobs', done: true },
  ];
  assert.equal(syncSeedTodos(board, seeds).added, 2);
  assert.equal(syncSeedTodos(board, seeds).added, 0);
  assert.equal(setTodoDone(board, board.todos[0].id, true).ok, true);
  assert.equal(removeTodo(board, board.todos[1].id).ok, true);
  const restored = restoreJobBoard(serializeJobBoard(board));
  assert.equal(restored.todos[0].done, true);
  assert.equal(restored.todos[1].hidden, true);
  assert.equal(syncSeedTodos(restored, seeds).added, 0);
});

test('user and agent tasks can be added without duplicates', () => {
  const board = createJobBoard();
  const first = addTodo(board, { title: 'Test the little app', source: 'user' });
  assert.equal(first.ok, true);
  assert.equal(addTodo(board, { title: 'test the little app!', source: 'agent' }).reason, 'todo_duplicate');
  assert.equal(addTodo(board, { title: 'Review accessibility', details: 'Check labels', source: 'agent' }).ok, true);
  assert.equal(board.todos[1].section, 'Agent ideas');
  assert.equal(removeTodo(board, first.todo.id).ok, true);
  assert.equal(addTodo(board, { title: 'Test the little app', source: 'user' }).ok, true);
  assert.deepEqual(restoreJobBoard(serializeJobBoard(board)), board);
});

test('agent task response is bounded and grounded in current board work', () => {
  assert.equal(parseTodoResponse('{"todos":[{"title":"Check tests","details":"Run the suite"}]}').length, 1);
  assert.throws(() => parseTodoResponse('{"todos":[]}'));
  const board = createJobBoard();
  postJob(board, { title: 'Build a small story' });
  addTodo(board, { title: 'Try the story', source: 'user' });
  assert.match(todoContext(board), /Build a small story/);
  assert.match(todoContext(board), /Try the story/);
});
