import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStandaloneHtml, htmlFilename } from '../src/client/domain/artifact-html.js';

test('a standalone HTML answer can be previewed and downloaded', () => {
  const result = '<!doctype html><html><head><title>Calculator</title></head><body><button onclick="alert(2 + 2)">Add</button></body></html>';
  const html = extractStandaloneHtml(result);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<button onclick="alert\(2 \+ 2\)">/);
  assert.equal(htmlFilename('Tiny Calculator!'), 'tiny-calculator.html');
});

test('Markdown HTML, CSS, and JS blocks become one HTML file', () => {
  const result = 'Here is the app:\n```html\n<div id="result">0</div>\n```\n```css\n#result { color: blue; }\n```\n```js\ndocument.querySelector("#result").textContent = 4;\n```';
  const html = extractStandaloneHtml(result);
  assert.match(html, /<div id="result">0<\/div>/);
  assert.match(html, /<style>[\s\S]*color: blue/);
  assert.match(html, /<script>[\s\S]*textContent = 4/);
  assert.match(html, /connect-src 'none'/);
  assert.equal(extractStandaloneHtml('I made a calculator, but here are only instructions.'), null);
});
