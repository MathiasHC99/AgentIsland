const fencedCode = /```[ \t]*([\w.+-]*)[^\n]*\r?\n([\s\S]*?)\r?\n?```/g;
const previewPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'";

/** Turn a model's HTML result into a single file the browser can open. */
export function extractStandaloneHtml(result) {
  if (typeof result !== 'string') return null;
  const blocks = [...result.matchAll(fencedCode)].map(match => ({
    language: match[1].toLowerCase(), code: match[2].trim(),
  }));
  let html = blocks.find(block => ['', 'html', 'htm'].includes(block.language) && /<\w+[\s>]/.test(block.code))?.code;
  if (!html) {
    const complete = result.match(/<!doctype\s+html[\s\S]*?<\/html\s*>/i)
      || result.match(/<html\b[\s\S]*?<\/html\s*>/i);
    html = complete?.[0] || (/^\s*<(?:!doctype\s+html|html\b|head\b|body\b|main\b|div\b|section\b)/i.test(result)
      ? result.trim() : null);
  }
  if (!html) return null;
  const css = blocks.filter(block => block.language === 'css').map(block => block.code).join('\n');
  const js = blocks.filter(block => ['js', 'javascript'].includes(block.language)).map(block => block.code).join('\n');
  const csp = `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">`;
  const style = css ? `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>` : '';
  const script = js ? `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>` : '';
  if (/<html\b/i.test(html)) {
    html = /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b[^>]*>/i, match => match + csp + style)
      : html.replace(/<html\b[^>]*>/i, match => match + '<head>' + csp + style + '</head>');
    return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, script + '</body>') : html + script;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${html}${script}</body></html>`;
}

export function htmlFilename(title) {
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return (slug || 'agent-island-app') + '.html';
}
