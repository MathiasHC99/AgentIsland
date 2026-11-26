import { readFile } from 'node:fs/promises';

export async function createTodoSeed() {
  const source = await readFile(new URL('../TODO.md', import.meta.url), 'utf8');
  let section = 'Project plan';
  const seeds = [];
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) { section = heading[1].trim(); continue; }
    const item = line.match(/^- \[([ xX])\] (.+)$/);
    if (item) seeds.push({ title: item[2].trim(), done: item[1].toLowerCase() === 'x', section });
  }
  return `// Generated from TODO.md when the local server or build starts.\nexport const seedTodos = ${JSON.stringify(seeds)};\n`;
}
