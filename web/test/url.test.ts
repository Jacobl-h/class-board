import { describe, expect, it } from 'vitest';
import { serverHref } from '../src/util/url';

describe('serverHref', () => {
  it('resolves a server-relative path against the server origin', () => {
    expect(serverHref('http://localhost:8787', '/boards/main/files/abc')).toBe('http://localhost:8787/boards/main/files/abc');
  });

  it('ignores a trailing slash on the server url', () => {
    expect(serverHref('https://board.example.workers.dev/', '/boards/main/shots/xyz')).toBe(
      'https://board.example.workers.dev/boards/main/shots/xyz',
    );
  });

  it('passes absolute urls through unchanged', () => {
    const thumb = 'https://i.ytimg.com/vi/abc123/hqdefault.jpg';
    expect(serverHref('http://localhost:8787', thumb)).toBe(thumb);
    expect(serverHref('http://localhost:8787', 'HTTP://Example.com')).toBe('HTTP://Example.com');
  });

  it('keeps the query string and hash of a relative path', () => {
    expect(serverHref('http://localhost:8787', '/boards/main/files/abc?x=1#top')).toBe(
      'http://localhost:8787/boards/main/files/abc?x=1#top',
    );
  });
});
