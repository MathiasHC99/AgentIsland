import { extractStandaloneHtml } from '../domain/artifact-html.js';

export function parseDecision(text, kind) {
  if (typeof text !== 'string') throw new Error('An agent returned an invalid decision.');
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error('An agent returned an invalid decision.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An agent returned an invalid decision.');
  if (kind === 'helpdesk') {
    if (typeof value.resolved !== 'boolean' || typeof value.guidance !== 'string' || !value.guidance.trim()) {
      throw new Error('The Helpdesk did not return usable guidance.');
    }
    return { resolved: value.resolved, guidance: value.guidance.trim().slice(0, 1500) };
  }
  const verdict = kind === 'review' ? 'approved' : 'passed';
  if (typeof value[verdict] !== 'boolean' || typeof value.needsHuman !== 'boolean'
      || typeof value.notes !== 'string' || !value.notes.trim()) {
    throw new Error('An agent returned an invalid decision.');
  }
  return { [verdict]: value[verdict], needsHuman: value.needsHuman, notes: value.notes.trim().slice(0, 1500) };
}

export async function smokeTestDeliverable(job, timeoutMs = 5000) {
  const asksForApp = /\b(app|application|website|web\s?page|site|calculator|browser)\b/i.test(job.title + ' ' + job.description);
  if (!asksForApp) return 'No browser artifact requested; no runtime check available.';
  const html = extractStandaloneHtml(job.teamRun?.final);
  if (!html) return 'FAIL: The requested browser app is not a standalone HTML file.';
  const documentPreview = new DOMParser().parseFromString(html, 'text/html');
  if (documentPreview.querySelector('script[src],link[rel="stylesheet"][href]')) {
    return 'FAIL: The app depends on external files, so the standalone download cannot run by itself.';
  }
  const marker = crypto.randomUUID();
  const errors = [];
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;visibility:hidden';
  const instrumentation = `<script>addEventListener('error',e=>parent.postMessage({marker:'${marker}',kind:'error',message:e.message},'*'));addEventListener('unhandledrejection',e=>parent.postMessage({marker:'${marker}',kind:'error',message:String(e.reason)},'*'));addEventListener('load',()=>setTimeout(()=>parent.postMessage({marker:'${marker}',kind:'done'},'*'),300));<\/script>`;
  const instrumented = html.replace(/(<meta\s+http-equiv="Content-Security-Policy"[^>]*>)/i, '$1' + instrumentation);
  return new Promise(resolve => {
    let timer;
    function finish(note) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(note);
    }
    function onMessage(event) {
      if (event.source !== frame.contentWindow || event.data?.marker !== marker) return;
      if (event.data.kind === 'error') errors.push(String(event.data.message || 'Script error').slice(0, 200));
      if (event.data.kind === 'done') finish(errors.length ? 'FAIL: Browser runtime error: ' + errors.join('; ') : 'PASS: Standalone HTML loaded without a reported browser runtime error. This does not prove every interaction works.');
    }
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish('FAIL: Browser smoke test timed out.'), timeoutMs);
    document.body.append(frame);
    frame.srcdoc = instrumented;
  });
}
