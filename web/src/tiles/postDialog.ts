import { LIMITS } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, PostContent, SlotIndex } from '@class-board/shared/types';
import { NOTES, planLink, type LinkPlan } from '@class-board/shared/urls';
import type { PostDialogDeps } from '../contracts';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';
import './postDialog.css';

type Tab = 'link' | 'html';
type UploadCode = 'too_large' | 'invalid' | 'rate_limited' | 'network';

const REJECTED: Record<Extract<LinkPlan, { ok: false }>['reason'], string> = {
  invalid: "That doesn't look like a link. Paste the full address, starting with https://.",
  scheme: 'Only http and https links can be posted.',
  host: "Links to local or private addresses can't be shown. Post a public link, or upload the HTML file.",
  too_long: 'That link is longer than 2,048 characters. Post a shorter link.',
};

const UPLOAD_ERRORS: Record<UploadCode, string> = {
  too_large: 'That file is over 1 MB. Upload a smaller HTML file.',
  invalid: "That file isn't an HTML page. Choose a .html or .htm file saved as UTF-8.",
  rate_limited: 'Too many uploads in the last minute. Wait a moment, then press Post to try again.',
  network: "The upload didn't reach the board server. Check your connection, then press Post to try again.",
};

const NO_HTML = 'Choose an HTML file, drop one here, or paste HTML.';
const NOT_HTML_FILE = 'Only .html or .htm files can be uploaded.';
const NO_LINK = 'Paste a link to post.';
const UNKNOWN_ERROR = 'Something went wrong. Press Post to try again.';

function reqId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function codeOf(e: unknown): string | null {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;
}

function isHtmlName(name: string): boolean {
  return /\.html?$/i.test(name);
}

function previewOf(plan: LinkPlan): { text: string; tone: 'ok' | 'warn' | 'error' } {
  if (!plan.ok) return { text: REJECTED[plan.reason], tone: 'error' };
  switch (plan.kind) {
    case 'claude-new':
      return { text: NOTES.claudeNew, tone: 'warn' };
    case 'claude-published':
      return {
        text: "Published Claude artifact. It shows live only if its owner added this board to the artifact's Allowed domains.",
        tone: 'ok',
      };
    case 'youtube':
      return { text: 'YouTube video. It plays in the tile.', tone: 'ok' };
    default:
      return { text: `Link to ${new URL(plan.url).host}. The board checks whether it can run in the tile.`, tone: 'ok' };
  }
}

export function openPostDialog(deps: PostDialogDeps, slot: SlotIndex, mode: 'add' | 'replace'): void {
  const { socket, state } = deps;
  const view = state.tile(slot);
  const baseVersion = view.version;
  const name = slotName(slot);

  let tab: Tab = 'link';
  let chosenFile: File | null = null;
  let sending = false;
  let closed = false;
  /** Keeps the file id of an upload whose post failed, so a retry doesn't upload it again. */
  let uploaded: { source: File | string; fileId: string } | null = null;

  const tabButton = (id: Tab, text: string) =>
    h('button', { type: 'button', class: 'post-tab', dataset: { tab: id }, textContent: text, attrs: { role: 'tab' } }) as HTMLButtonElement;
  const linkTab = tabButton('link', 'Link');
  const htmlTab = tabButton('html', 'HTML file');

  const urlInput = h('input', {
    type: 'url',
    name: 'url',
    placeholder: 'https://…',
    autocomplete: 'off',
    attrs: { 'aria-label': 'Link' },
  }) as HTMLInputElement;
  const preview = h('p', { class: 'link-preview', attrs: { 'aria-live': 'polite' } });
  const linkPanel = h('div', { class: 'post-panel', dataset: { panel: 'link' } }, urlInput, preview);

  const fileInput = h('input', { type: 'file', name: 'file', accept: '.html,.htm,text/html' }) as HTMLInputElement;
  const fileName = h('span', { class: 'post-file-name' });
  const pasteArea = h('textarea', {
    name: 'html',
    rows: 6,
    placeholder: 'Or paste HTML here',
    attrs: { 'aria-label': 'HTML', spellcheck: 'false' },
  }) as HTMLTextAreaElement;
  const dropZone = h(
    'label',
    { class: 'post-drop' },
    h('span', { class: 'post-drop-text', textContent: 'Choose an .html file or drop it here' }),
    fileInput,
    fileName,
  );
  const htmlPanel = h('div', { class: 'post-panel', dataset: { panel: 'html' }, hidden: true }, dropZone, pasteArea);

  const labelInput = h('input', {
    type: 'text',
    name: 'label',
    value: deps.defaultLabel(),
    maxLength: LIMITS.labelMax,
    autocomplete: 'off',
  }) as HTMLInputElement;
  const labelField = h('label', { class: 'post-label' }, h('span', { textContent: 'Name above the tile' }), labelInput);

  const owner = view.label || view.authorName;
  const warning =
    mode === 'replace'
      ? h('p', {
          class: 'post-warning',
          textContent: owner
            ? `This replaces ${owner}'s tile. Their version stays in History.`
            : `This replaces what's in ${name}. The current version stays in History.`,
        })
      : null;
  const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' }, hidden: true });
  const submit = h('button', {
    type: 'submit',
    class: 'post-submit',
    dataset: { action: 'submit' },
    textContent: mode === 'replace' ? 'Replace' : 'Post',
  }) as HTMLButtonElement;

  const form = h(
    'form',
    { class: 'post-form', attrs: { novalidate: '' } },
    warning,
    h('div', { class: 'post-tabs', attrs: { role: 'tablist' } }, linkTab, htmlTab),
    linkPanel,
    htmlPanel,
    labelField,
    error,
    h('div', { class: 'post-footer' }, submit),
  );

  const modal = openModal({
    title: mode === 'replace' ? `Replace ${name}` : `Add to ${name}`,
    body: form,
    dialog: 'post',
    onClose: () => {
      closed = true;
    },
  });

  function showError(text: string | null): void {
    error.textContent = text ?? '';
    error.hidden = text === null;
  }

  function selectTab(next: Tab): void {
    tab = next;
    linkTab.setAttribute('aria-selected', String(next === 'link'));
    htmlTab.setAttribute('aria-selected', String(next === 'html'));
    linkTab.classList.toggle('is-selected', next === 'link');
    htmlTab.classList.toggle('is-selected', next === 'html');
    linkPanel.hidden = next !== 'link';
    htmlPanel.hidden = next !== 'html';
    showError(null);
  }

  function chooseFile(file: File | null): void {
    chosenFile = file;
    fileName.textContent = file ? file.name : '';
    if (file) pasteArea.value = '';
    showError(null);
  }

  function updatePreview(): void {
    const text = urlInput.value.trim();
    if (text === '') {
      preview.textContent = '';
      delete preview.dataset.tone;
      return;
    }
    const { text: message, tone } = previewOf(planLink(text));
    preview.textContent = message;
    preview.dataset.tone = tone;
  }

  function uploadMessage(e: unknown): string {
    const code = codeOf(e);
    return code !== null && code in UPLOAD_ERRORS ? UPLOAD_ERRORS[code as UploadCode] : UPLOAD_ERRORS.network;
  }

  function requestMessage(e: unknown): string {
    const code = codeOf(e);
    if (code === 'conflict') return `Someone just posted to ${name}. Pick another tile or replace theirs.`;
    return code !== null ? errorText(code as ErrorCode) : UNKNOWN_ERROR;
  }

  /** Returns the content to post, or null after showing why it can't be posted. */
  async function prepareContent(): Promise<PostContent | null> {
    if (tab === 'link') {
      const text = urlInput.value.trim();
      if (text === '') {
        showError(NO_LINK);
        return null;
      }
      const plan = planLink(text);
      if (!plan.ok) {
        showError(REJECTED[plan.reason]);
        return null;
      }
      return { kind: 'link', url: plan.url };
    }

    const pasted = pasteArea.value;
    const source: File | string | null = chosenFile ?? (pasted.trim() === '' ? null : pasted);
    if (source === null) {
      showError(NO_HTML);
      return null;
    }
    if (typeof source !== 'string' && !isHtmlName(source.name)) {
      showError(NOT_HTML_FILE);
      return null;
    }
    const blob = typeof source === 'string' ? new Blob([source], { type: 'text/html;charset=utf-8' }) : source;
    if (blob.size > LIMITS.htmlMaxBytes) {
      showError(UPLOAD_ERRORS.too_large);
      return null;
    }
    if (uploaded && uploaded.source === source) return { kind: 'html', fileId: uploaded.fileId };
    try {
      const fileId = await deps.upload(blob, typeof source === 'string' ? 'pasted.html' : source.name);
      uploaded = { source, fileId };
      return { kind: 'html', fileId };
    } catch (e) {
      showError(uploadMessage(e));
      return null;
    }
  }

  async function send(): Promise<void> {
    if (sending) return;
    sending = true;
    submit.disabled = true;
    showError(null);
    try {
      const content = await prepareContent();
      if (content === null || closed) return;
      const label = (labelInput.value.trim() || deps.defaultLabel()).slice(0, LIMITS.labelMax);
      await socket.request({ type: 'post', reqId: reqId(), slot, baseVersion, content, label });
      modal.close();
    } catch (e) {
      showError(requestMessage(e));
    } finally {
      sending = false;
      submit.disabled = false;
    }
  }

  linkTab.addEventListener('click', () => selectTab('link'));
  htmlTab.addEventListener('click', () => selectTab('html'));
  urlInput.addEventListener('input', () => {
    updatePreview();
    showError(null);
  });
  fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0] ?? null));
  pasteArea.addEventListener('input', () => {
    if (chosenFile !== null) {
      chosenFile = null;
      fileInput.value = '';
      fileName.textContent = '';
    }
    showError(null);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });

  // Dropping a file anywhere on the dialog switches to the HTML tab and chooses it.
  modal.el.addEventListener('dragover', (e) => {
    e.preventDefault();
    modal.el.classList.add('is-dragging');
  });
  modal.el.addEventListener('dragleave', () => modal.el.classList.remove('is-dragging'));
  modal.el.addEventListener('drop', (e) => {
    e.preventDefault();
    modal.el.classList.remove('is-dragging');
    const file = (e as DragEvent).dataTransfer?.files?.[0] ?? null;
    if (!file) return;
    selectTab('html');
    chooseFile(file);
  });

  selectTab('link');
  urlInput.focus();
}
