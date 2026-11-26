/** Parse one bounded brainstorm response before it enters the saved board. */
export function parseIdeaResponse(text) {
  if (typeof text !== 'string') throw new Error('The Dreamer did not return ideas.');
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('The Dreamer returned invalid JSON. Try again with another model.'); }
  if (!value || !Array.isArray(value.ideas) || value.ideas.length < 1 || value.ideas.length > 3
      || value.ideas.some(idea => !idea || typeof idea.title !== 'string'
        || typeof idea.why !== 'string' || typeof idea.doneWhen !== 'string')) {
    throw new Error('The Dreamer did not return one to three complete ideas.');
  }
  return value.ideas;
}

export function ideaContext(board, theme = '') {
  const jobs = board.jobs.slice(-12).map(job => `${job.title} (${job.status})`).join('; ') || 'No jobs yet';
  const ideas = board.ideas.slice(-12).map(idea => idea.title).join('; ') || 'No saved ideas yet';
  return `Island goals: playful, useful projects that the local AI team can make and the user can open or read. Theme: ${theme.trim() || 'Surprise me'}. Existing jobs: ${jobs}. Saved ideas: ${ideas}. Make each proposal specific and feasible.`.slice(0, 2000);
}
