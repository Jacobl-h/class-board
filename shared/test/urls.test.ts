import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/constants';
import { NOTES, originOf, planLink } from '../src/urls';

describe('planLink: accepted links', () => {
  it('plans a plain https link as generic, embedding the normalized URL', () => {
    expect(planLink('https://example.com/page?x=1#top')).toEqual({
      ok: true,
      kind: 'generic',
      url: 'https://example.com/page?x=1#top',
      embedUrl: 'https://example.com/page?x=1#top',
      thumbUrl: null,
    });
  });

  it('accepts http links and normalizes the host case and empty path', () => {
    expect(planLink('HTTP://Example.COM')).toMatchObject({ ok: true, kind: 'generic', url: 'http://example.com/' });
  });

  it('trims surrounding whitespace, including newlines', () => {
    expect(planLink('  \n https://example.com/a \t')).toMatchObject({ ok: true, url: 'https://example.com/a' });
  });

  it('keeps ports and lets a trailing-dot public host through', () => {
    expect(planLink('https://example.com:8443/x')).toMatchObject({ ok: true, url: 'https://example.com:8443/x' });
    expect(planLink('https://example.com./x')).toMatchObject({ ok: true, kind: 'generic' });
  });

  it('converts internationalized hosts to punycode', () => {
    expect(planLink('https://中文.com/')).toMatchObject({ ok: true, url: 'https://xn--fiq228c.com/' });
  });

  it('accepts a link of exactly the maximum length', () => {
    const url = 'https://example.com/' + 'a'.repeat(LIMITS.urlMax - 'https://example.com/'.length);
    expect(url).toHaveLength(LIMITS.urlMax);
    expect(planLink(url)).toMatchObject({ ok: true, kind: 'generic' });
  });
});

describe('planLink: rejected links', () => {
  it('rejects schemes other than http and https', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'ftp://example.com/file',
      'file:///etc/passwd',
      'mailto:a@example.com',
      'blob:https://example.com/1234',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'scheme' });
    }
  });

  it('rejects IPv4 literals, including forms the URL parser normalizes', () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://192.168.1.10:3000/',
      'https://8.8.8.8/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://127.1/',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('rejects IPv6 literals', () => {
    for (const bad of ['http://[::1]/', 'http://[::1]:8080/x', 'https://[2001:db8::1]/', 'http://[::ffff:1.2.3.4]/']) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('rejects localhost, .localhost, .local and .internal hosts, with or without a trailing dot', () => {
    for (const bad of [
      'http://localhost:5173/',
      'http://LOCALHOST/',
      'http://localhost./',
      'http://app.localhost/',
      'http://printer.local/',
      'https://db.internal/',
      'https://a.b.internal./',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('does not reject public hosts that merely contain those words', () => {
    for (const ok of ['https://localhost.example.com/', 'https://notlocal.com/', 'https://internal.example.org/']) {
      expect(planLink(ok)).toMatchObject({ ok: true });
    }
  });

  it('rejects links longer than the limit before parsing them', () => {
    const long = 'https://example.com/' + 'a'.repeat(LIMITS.urlMax);
    expect(planLink(long)).toEqual({ ok: false, reason: 'too_long' });
    expect(planLink('x'.repeat(LIMITS.urlMax + 1))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('rejects garbage as invalid', () => {
    for (const bad of ['', '   ', 'not a url', 'example.com', 'https://', 'http://exa mple.com', '//example.com', 'http://1.2.3.256']) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(planLink(undefined as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
    expect(planLink(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('originOf', () => {
  it('returns the origin of http and https URLs', () => {
    expect(originOf('https://jacobl-h.github.io/class-board/?board=x#C4')).toBe('https://jacobl-h.github.io');
    expect(originOf('http://localhost:5173/a')).toBe('http://localhost:5173');
    expect(originOf('https://example.com:443/')).toBe('https://example.com');
  });

  it('returns null for other schemes and for input that is not a URL', () => {
    expect(originOf('data:text/html,hi')).toBeNull();
    expect(originOf('blob:https://example.com/1')).toBeNull();
    expect(originOf('ftp://example.com')).toBeNull();
    expect(originOf('nope')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});

describe('NOTES', () => {
  it('has the exact user-facing texts from the spec', () => {
    expect(NOTES.claudeNew).toBe(
      "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead.",
    );
    expect(NOTES.blocked).toBe("This site doesn't allow embedding. Open it in a new tab.");
    expect(NOTES.claudeAllow('jacobl-h.github.io')).toBe(
      "Add jacobl-h.github.io to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.",
    );
  });
});

const YT = 'dQw4w9WgXcQ';
const YT_EMBED = `https://www.youtube-nocookie.com/embed/${YT}`;
const YT_THUMB = `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`;

describe('planLink: YouTube', () => {
  it('rewrites watch links to the no-cookie embed and a thumbnail', () => {
    const plan = planLink(`https://www.youtube.com/watch?v=${YT}`);
    expect(plan).toEqual({
      ok: true,
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${YT}`,
      embedUrl: YT_EMBED,
      thumbUrl: YT_THUMB,
    });
  });

  it('drops extra parameters such as the playlist and start time', () => {
    const plan = planLink(`https://www.youtube.com/watch?feature=share&list=PL123&v=${YT}&t=42s`);
    expect(plan).toMatchObject({ ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB });
  });

  it('handles youtu.be short links with a tracking parameter', () => {
    expect(planLink(`https://youtu.be/${YT}?si=abcdef`)).toMatchObject({
      ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB,
    });
  });

  it('handles shorts links', () => {
    expect(planLink(`https://www.youtube.com/shorts/${YT}?feature=share`)).toMatchObject({
      ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB,
    });
  });

  it('handles the mobile and bare youtube.com hosts', () => {
    expect(planLink(`https://m.youtube.com/watch?v=${YT}&pp=x`)).toMatchObject({ kind: 'youtube', embedUrl: YT_EMBED });
    expect(planLink(`https://youtube.com/watch?v=${YT}`)).toMatchObject({ kind: 'youtube', embedUrl: YT_EMBED });
  });

  it('keeps the original link for Open in new tab', () => {
    const plan = planLink(`  https://youtu.be/${YT}  `);
    expect(plan).toMatchObject({ ok: true, url: `https://youtu.be/${YT}` });
  });

  it('treats a YouTube link without a valid video id as generic', () => {
    for (const link of [
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/feed/subscriptions',
      'https://youtu.be/',
      'https://www.youtube.com/@somechannel',
    ]) {
      expect(planLink(link)).toMatchObject({ ok: true, kind: 'generic', thumbUrl: null });
    }
  });

  it('does not treat look-alike hosts as YouTube', () => {
    expect(planLink(`https://youtube.com.evil.example/watch?v=${YT}`)).toMatchObject({ kind: 'generic' });
    expect(planLink(`https://notyoutu.be/${YT}`)).toMatchObject({ kind: 'generic' });
  });
});

describe('planLink: Claude artifacts', () => {
  it('rewrites a published artifact to its /embed URL', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123_XYZ')).toEqual({
      ok: true,
      kind: 'claude-published',
      url: 'https://claude.ai/public/artifacts/abc-123_XYZ',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123_XYZ/embed',
      thumbUrl: null,
    });
  });

  it('accepts a trailing slash and drops query and fragment from the embed URL', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123/?utm=1#x')).toMatchObject({
      kind: 'claude-published',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123/embed',
    });
  });

  it('keeps a URL that already ends in /embed', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123/embed')).toEqual({
      ok: true,
      kind: 'claude-published',
      url: 'https://claude.ai/public/artifacts/abc-123/embed',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123/embed',
      thumbUrl: null,
    });
  });

  it('marks claude.ai/artifact/<id> as not embeddable', () => {
    expect(planLink('https://claude.ai/artifact/abc-123')).toEqual({
      ok: true,
      kind: 'claude-new',
      url: 'https://claude.ai/artifact/abc-123',
      embedUrl: null,
      thumbUrl: null,
    });
  });

  it('marks claude.ai/code/artifact/<id> as not embeddable', () => {
    expect(planLink('https://claude.ai/code/artifact/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({
      ok: true,
      kind: 'claude-new',
      embedUrl: null,
      thumbUrl: null,
    });
  });

  it('treats other claude.ai paths and look-alike hosts as generic', () => {
    for (const link of [
      'https://claude.ai/chat/123',
      'https://claude.ai/public/artifacts/',
      'https://claude.ai/public/artifacts/abc/other',
      'https://claude.ai/artifact/',
      'https://claude.ai/artifact/abc/extra',
      'https://claude.ai.evil.example/public/artifacts/abc',
      'https://example.com/public/artifacts/abc',
    ]) {
      expect(planLink(link)).toMatchObject({ ok: true, kind: 'generic' });
    }
  });
});
