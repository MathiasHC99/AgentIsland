import { extractStandaloneHtml, htmlFilename } from '../domain/artifact-html.js';

function previewDialog() {
  let dialog = document.querySelector('#artifact-preview');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'artifact-preview';
  dialog.className = 'artifact-preview';
  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('strong');
  title.textContent = 'App preview';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);
  const frame = document.createElement('iframe');
  frame.title = 'Generated app preview';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  dialog.addEventListener('close', () => frame.removeAttribute('srcdoc'));
  dialog.append(header, frame);
  document.body.append(dialog);
  return dialog;
}

export function appendArtifactActions(container, job) {
  const html = extractStandaloneHtml(job.teamRun?.final);
  if (!html) return;
  const actions = document.createElement('div');
  actions.className = 'artifact-actions';
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'secondary-button';
  preview.textContent = 'Preview app';
  preview.addEventListener('click', () => {
    const dialog = previewDialog();
    dialog.querySelector('iframe').srcdoc = html;
    dialog.showModal();
  });
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-button';
  download.textContent = 'Download HTML';
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = htmlFilename(job.title);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  actions.append(preview, download);
  container.append(actions);
}
