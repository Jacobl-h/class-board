export type UploadErrorCode = 'too_large' | 'invalid' | 'rate_limited' | 'network';

const MESSAGES: Record<UploadErrorCode, string> = {
  too_large: 'That file is over 1 MB. Choose a smaller HTML file.',
  invalid: "That isn't an HTML file the board can use. Choose an .html file and try again.",
  rate_limited: 'Too many uploads. Wait a minute and try again.',
  network: "The upload didn't go through. Check your connection and try again.",
};

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode) {
    super(MESSAGES[code]);
    this.name = 'UploadError';
    this.code = code;
  }
}

/**
 * Uploads one HTML file and resolves with its file id. `clientId`, when given, goes in X-Client-Id so the
 * server can rate-limit each student rather than a whole class behind one school IP.
 */
export async function uploadHtml(
  serverUrl: string,
  board: string,
  html: Blob,
  fileName: string,
  clientId?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-File-Name': encodeURIComponent(fileName),
  };
  if (clientId) headers['X-Client-Id'] = clientId;
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, '')}/boards/${board}/files`, {
      method: 'POST',
      headers,
      body: html,
    });
  } catch {
    throw new UploadError('network');
  }
  if (res.status === 413) throw new UploadError('too_large');
  if (res.status === 400) throw new UploadError('invalid');
  if (res.status === 429) throw new UploadError('rate_limited');
  // Any other failure (403 origin, 5xx) is not something the student can fix by changing the file.
  if (!res.ok) throw new UploadError('network');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UploadError('network');
  }
  const fileId = (body as { fileId?: unknown } | null)?.fileId;
  if (typeof fileId !== 'string' || fileId === '') throw new UploadError('network');
  return fileId;
}
