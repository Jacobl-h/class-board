import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { ErrorCode, RequestMsg, ServerMsg, TileView } from '@class-board/shared/types';
import { NOTES } from '@class-board/shared/urls';
import type { BoardSocket, BoardStateApi, PostDialogDeps } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { openPostDialog } from '../src/tiles/postDialog';

const C4 = 23;

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

function emptyView(slot: number): TileView {
  return {
    slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

function serverError(code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(code), { code });
}

function uploadError(code: 'too_large' | 'invalid' | 'rate_limited' | 'network'): Error & { code: string } {
  return Object.assign(new Error(code), { name: 'UploadError', code });
}

/** Resolves only when the test says so, to observe the dialog mid-request. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(tile: TileView = emptyView(C4)) {
  const tiles = Array.from({ length: SLOT_COUNT }, (_, i) => emptyView(i));
  tiles[tile.slot] = tile;
  const sent: RequestMsg[] = [];
  let reply: (msg: RequestMsg) => Promise<Reply> = async (msg) => ({ type: 'ok', reqId: msg.reqId });
  const socket = {
    request: vi.fn((msg: RequestMsg) => {
      sent.push(msg);
      return reply(msg);
    }),
  } as unknown as BoardSocket;
  const state = { tile: (slot: number) => tiles[slot] } as unknown as BoardStateApi;
  const uploads: Array<{ html: Blob; fileName: string }> = [];
  let uploadImpl: (html: Blob, fileName: string) => Promise<string> = async () => 'f'.repeat(32);
  const deps: PostDialogDeps = {
    socket,
    state,
    upload: vi.fn((html: Blob, fileName: string) => {
      uploads.push({ html, fileName });
      return uploadImpl(html, fileName);
    }),
    defaultLabel: () => 'Maya',
  };
  return {
    deps,
    sent,
    uploads,
    tiles,
    setReply(fn: (msg: RequestMsg) => Promise<Reply>) {
      reply = fn;
    },
    setUpload(fn: (html: Blob, fileName: string) => Promise<string>) {
      uploadImpl = fn;
    },
  };
}

const dialog = () => document.querySelector<HTMLElement>('.modal[data-dialog="post"]');
const q = <T extends Element>(sel: string) => dialog()!.querySelector<T>(sel)!;
const submitBtn = () => q<HTMLButtonElement>('[data-action="submit"]');
const errorEl = () => q<HTMLElement>('.dialog-error');
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function type(sel: string, value: string): void {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function chooseFile(file: File): void {
  const input = q<HTMLInputElement>('input[name="file"]');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dropFile(file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  // happy-dom's DragEvent ignores dataTransfer in its init dict, so attach it directly.
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  q<HTMLElement>('.post-form').dispatchEvent(ev);
}

async function submit(): Promise<void> {
  submitBtn().click();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});

describe('openPostDialog: layout', () => {
  it('opens the post modal on the link tab with the label prefilled from the cursor name', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    expect(dialog()).not.toBeNull();
    expect(q('[data-tab="link"]').getAttribute('aria-selected')).toBe('true');
    expect(q<HTMLElement>('[data-panel="link"]').hidden).toBe(false);
    expect(q<HTMLElement>('[data-panel="html"]').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="label"]').value).toBe('Maya');
    expect(q<HTMLInputElement>('input[name="label"]').maxLength).toBe(40);
    expect(dialog()!.textContent).not.toContain('This replaces');
  });

  it('switches to the HTML tab with a file input and a paste area', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    expect(q<HTMLElement>('[data-panel="html"]').hidden).toBe(false);
    expect(q<HTMLElement>('[data-panel="link"]').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="file"]').accept).toBe('.html,.htm,text/html');
    expect(q('textarea[name="html"]')).not.toBeNull();
  });

  it("warns in replace mode, naming the tile's label", () => {
    const { deps } = makeDeps({ ...emptyView(C4), version: 7, kind: 'link', label: 'Maya', authorName: 'Maya R' });
    openPostDialog(deps, C4, 'replace');
    expect(q('.post-warning').textContent).toBe("This replaces Maya's tile. Their version stays in History.");
  });

  it('falls back to the author name when the tile has no label', () => {
    const { deps } = makeDeps({ ...emptyView(C4), version: 7, kind: 'link', label: '', authorName: 'Ben' });
    openPostDialog(deps, C4, 'replace');
    expect(q('.post-warning').textContent).toBe("This replaces Ben's tile. Their version stays in History.");
  });
});

describe('openPostDialog: link preview', () => {
  it('explains a rejected link as the student types', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'ftp://files.example.com/x');
    expect(q('.link-preview').textContent).toBe('Only http and https links can be posted.');
    type('input[name="url"]', 'http://localhost:3000/');
    expect(q('.link-preview').textContent).toContain("Links to local or private addresses can't be shown");
  });

  it('says early that a newer Claude artifact cannot be embedded', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'https://claude.ai/artifact/abc-123');
    expect(q('.link-preview').textContent).toBe(NOTES.claudeNew);
    expect(q<HTMLElement>('.link-preview').dataset.tone).toBe('warn');
  });

  it('names the host of an ordinary link and clears when emptied', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/play');
    expect(q('.link-preview').textContent).toContain('game.example.com');
    type('input[name="url"]', '');
    expect(q('.link-preview').textContent).toBe('');
  });
});

describe('openPostDialog: posting a link', () => {
  it('sends a post with the base version captured at open and closes on ok', async () => {
    const env = makeDeps({ ...emptyView(C4), version: 5, kind: 'link', label: 'Old' });
    openPostDialog(env.deps, C4, 'replace');
    env.tiles[C4] = { ...env.tiles[C4]!, version: 6 }; // a later update must not change baseVersion
    type('input[name="url"]', 'https://game.example.com/play');
    type('input[name="label"]', '  Team rocket  ');
    await submit();
    expect(env.sent).toHaveLength(1);
    const msg = env.sent[0] as Extract<RequestMsg, { type: 'post' }>;
    expect(msg).toMatchObject({
      type: 'post', slot: C4, baseVersion: 5, label: 'Team rocket',
      content: { kind: 'link', url: 'https://game.example.com/play' },
    });
    expect(msg.reqId).toMatch(/^[0-9a-z]{12}$/);
    expect(dialog()).toBeNull();
  });

  it('uses the cursor name when the label is left empty', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    type('input[name="label"]', '   ');
    await submit();
    expect((env.sent[0] as Extract<RequestMsg, { type: 'post' }>).label).toBe('Maya');
  });

  it('does not send a rejected or empty link', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    await submit();
    expect(errorEl().textContent).toBe('Paste a link to post.');
    type('input[name="url"]', 'not a link');
    await submit();
    expect(env.sent).toHaveLength(0);
    expect(errorEl().hidden).toBe(false);
    expect(errorEl().textContent).toContain("doesn't look like a link");
  });

  it('disables submit while sending and ignores a second click', async () => {
    const env = makeDeps();
    const pending = deferred<Reply>();
    env.setReply(() => pending.promise);
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(submitBtn().disabled).toBe(true);
    await submit();
    expect(env.sent).toHaveLength(1);
    pending.resolve({ type: 'ok', reqId: env.sent[0]!.reqId });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('shows the conflict message with the slot name and stays open', async () => {
    const env = makeDeps();
    env.setReply(async () => {
      throw serverError('conflict');
    });
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(errorEl().textContent).toBe('Someone just posted to C4. Pick another tile or replace theirs.');
    expect(dialog()).not.toBeNull();
    expect(submitBtn().disabled).toBe(false);
  });

  it('shows errorText for other server errors', async () => {
    const env = makeDeps();
    env.setReply(async () => {
      throw serverError('locked');
    });
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(errorEl().textContent).toBe(errorText('locked'));
  });
});

describe('openPostDialog: posting HTML', () => {
  it('uploads a chosen file, then posts its file id', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    const file = new File(['<title>Game</title><p>hi</p>'], 'game.html', { type: 'text/html' });
    chooseFile(file);
    await submit();
    expect(env.uploads).toEqual([{ html: file, fileName: 'game.html' }]);
    expect(env.sent[0]).toMatchObject({ type: 'post', content: { kind: 'html', fileId: 'f'.repeat(32) } });
    expect(dialog()).toBeNull();
  });

  it('uploads pasted HTML as pasted.html', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    type('textarea[name="html"]', '<h1>Hello</h1>');
    await submit();
    expect(env.uploads).toHaveLength(1);
    expect(env.uploads[0]!.fileName).toBe('pasted.html');
    expect(await env.uploads[0]!.html.text()).toBe('<h1>Hello</h1>');
  });

  it('accepts a file dropped anywhere on the dialog and switches to the HTML tab', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    dropFile(new File(['<p>drop</p>'], 'dropped.htm', { type: 'text/html' }));
    expect(q('[data-tab="html"]').getAttribute('aria-selected')).toBe('true');
    expect(q('.post-file-name').textContent).toBe('dropped.htm');
    await submit();
    expect(env.uploads[0]!.fileName).toBe('dropped.htm');
  });

  it('rejects files over 1 MB before uploading', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['<' + 'a'.repeat(1_000_000)], 'big.html', { type: 'text/html' }));
    await submit();
    expect(env.uploads).toHaveLength(0);
    expect(errorEl().textContent).toBe('That file is over 1 MB. Upload a smaller HTML file.');
  });

  it('rejects files that are not .html or .htm', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['x'], 'app.jsx'));
    await submit();
    expect(env.uploads).toHaveLength(0);
    expect(errorEl().textContent).toBe('Only .html or .htm files can be uploaded.');
  });

  it('asks for HTML when nothing was chosen or pasted', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    await submit();
    expect(errorEl().textContent).toBe('Choose an HTML file, drop one here, or paste HTML.');
  });

  it.each([
    ['too_large', 'That file is over 1 MB. Upload a smaller HTML file.'],
    ['invalid', "That file isn't an HTML page. Choose a .html or .htm file saved as UTF-8."],
    ['rate_limited', 'Too many uploads in the last minute. Wait a moment, then press Post to try again.'],
    ['network', "The upload didn't reach the board server. Check your connection, then press Post to try again."],
  ] as const)('explains an upload error %s and posts nothing', async (code, text) => {
    const env = makeDeps();
    env.setUpload(async () => {
      throw uploadError(code);
    });
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    type('textarea[name="html"]', '<p>x</p>');
    await submit();
    expect(errorEl().textContent).toBe(text);
    expect(env.sent).toHaveLength(0);
    expect(submitBtn().disabled).toBe(false);
  });

  it('does not upload the same file twice when only the post failed', async () => {
    const env = makeDeps();
    let first = true;
    env.setReply(async (msg) => {
      if (first) {
        first = false;
        throw serverError('rate_limited');
      }
      return { type: 'ok', reqId: msg.reqId };
    });
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['<p>x</p>'], 'page.html', { type: 'text/html' }));
    await submit();
    expect(errorEl().textContent).toBe(errorText('rate_limited'));
    await submit();
    expect(env.uploads).toHaveLength(1);
    expect(env.sent).toHaveLength(2);
    expect(dialog()).toBeNull();
  });
});
