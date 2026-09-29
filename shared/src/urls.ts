import { LIMITS } from './constants';

export type LinkPlan =
  | { ok: true; kind: 'generic' | 'youtube' | 'claude-published'; url: string; embedUrl: string; thumbUrl: string | null }
  | { ok: true; kind: 'claude-new'; url: string; embedUrl: null; thumbUrl: null }
  | { ok: false; reason: 'invalid' | 'scheme' | 'host' | 'too_long' };

export const NOTES = {
  claudeNew: "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead.",
  claudeAllow: (boardHost: string): string =>
    `Add ${boardHost} to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.`,
  blocked: "This site doesn't allow embedding. Open it in a new tab.",
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CLAUDE_ID_RE = /^[A-Za-z0-9_-]+$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YT_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const CLAUDE_HOSTS = new Set(['claude.ai', 'www.claude.ai']);

/** True for hosts a class board must never load: IP literals and local or internal names. */
function isBlockedHost(hostname: string): boolean {
  // new URL() has already normalized numeric hosts such as 2130706433 or 0x7f.1 to dotted IPv4.
  if (hostname.startsWith('[') || IPV4_RE.test(hostname)) return true;
  const host = hostname.replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

function youtubeId(u: URL): string | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | null | undefined = null;
  if (YT_SHORT_HOSTS.has(u.hostname)) id = parts[0];
  else if (YT_HOSTS.has(u.hostname)) {
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (parts[0] === 'shorts') id = parts[1];
  }
  return id && YT_ID_RE.test(id) ? id : null;
}

/** Matches claude.ai artifact links, including published ones that already end in /embed. */
function claudeArtifact(u: URL): { id: string; kind: 'published' | 'new' } | null {
  if (!CLAUDE_HOSTS.has(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'public' && parts[1] === 'artifacts') {
    const id = parts[2];
    const tail = parts.slice(3);
    const tailOk = tail.length === 0 || (tail.length === 1 && tail[0] === 'embed');
    return id && CLAUDE_ID_RE.test(id) && tailOk ? { id, kind: 'published' } : null;
  }
  const at = parts[0] === 'artifact' ? 1 : parts[0] === 'code' && parts[1] === 'artifact' ? 2 : -1;
  const id = at > 0 ? parts[at] : undefined;
  return id && CLAUDE_ID_RE.test(id) && parts.length === at + 1 ? { id, kind: 'new' } : null;
}

export function planLink(input: string): LinkPlan {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid' };
  const trimmed = input.trim();
  if (trimmed.length > LIMITS.urlMax) return { ok: false, reason: 'too_long' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: 'host' };

  const url = u.href;
  const yt = youtubeId(u);
  if (yt) {
    return {
      ok: true,
      kind: 'youtube',
      url,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}`,
      thumbUrl: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
    };
  }
  const claude = claudeArtifact(u);
  if (claude?.kind === 'published') {
    return {
      ok: true,
      kind: 'claude-published',
      url,
      embedUrl: `https://claude.ai/public/artifacts/${claude.id}/embed`,
      thumbUrl: null,
    };
  }
  if (claude?.kind === 'new') return { ok: true, kind: 'claude-new', url, embedUrl: null, thumbUrl: null };
  return { ok: true, kind: 'generic', url, embedUrl: url, thumbUrl: null };
}

/** The origin of an http(s) URL, or null for anything else (including unparsable input). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
