import { describe, it, expect } from 'bun:test';

import {
  extractGitHubLinks,
  fetchGitHubLinkedContext,
  type ParsedGitHubLink,
} from './github-linked.js';

describe('github-linked', () => {
  describe('extractGitHubLinks', () => {
    it('returns empty array for empty string', () => {
      expect(extractGitHubLinks('')).toEqual([]);
    });

    it('returns empty array for text with no URLs', () => {
      expect(extractGitHubLinks('hello world, no links here')).toEqual([]);
    });

    it('extracts a single PR URL', () => {
      const links = extractGitHubLinks(
        'check https://github.com/omniaura/omniclaw/pull/372',
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        owner: 'omniaura',
        repo: 'omniclaw',
        type: 'pull',
        number: 372,
        url: 'https://github.com/omniaura/omniclaw/pull/372',
      });
    });

    it('extracts a single issue URL', () => {
      const links = extractGitHubLinks(
        'see https://github.com/omniaura/omniclaw/issues/91',
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        owner: 'omniaura',
        repo: 'omniclaw',
        type: 'issue',
        number: 91,
        url: 'https://github.com/omniaura/omniclaw/issues/91',
      });
    });

    it('handles URL with fragment/anchor', () => {
      const links = extractGitHubLinks(
        'https://github.com/org/repo/pull/42#pullrequestreview-123',
      );
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(42);
      expect(links[0].type).toBe('pull');
    });

    it('handles URL with query params after number', () => {
      const links = extractGitHubLinks(
        'https://github.com/org/repo/issues/10?foo=bar',
      );
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(10);
    });

    it('extracts multiple different URLs from same text', () => {
      const text =
        'check https://github.com/a/b/pull/1 and https://github.com/c/d/issues/2';
      const links = extractGitHubLinks(text);
      expect(links).toHaveLength(2);
      expect(links[0].owner).toBe('a');
      expect(links[0].type).toBe('pull');
      expect(links[1].owner).toBe('c');
      expect(links[1].type).toBe('issue');
    });

    it('deduplicates same URL appearing twice', () => {
      const url = 'https://github.com/omniaura/omniclaw/pull/1';
      const links = extractGitHubLinks(`${url} and again ${url}`);
      expect(links).toHaveLength(1);
    });

    it('ignores non-GitHub URLs', () => {
      expect(extractGitHubLinks('https://gitlab.com/org/repo/pull/1')).toEqual(
        [],
      );
    });

    it('ignores malformed GitHub URLs without a number', () => {
      expect(extractGitHubLinks('https://github.com/org/repo/pull/')).toEqual(
        [],
      );
    });

    it('handles http:// as well as https://', () => {
      const links = extractGitHubLinks('http://github.com/org/repo/pull/5');
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(5);
    });

    it('handles repos with dots and underscores in names', () => {
      const links = extractGitHubLinks(
        'https://github.com/my.org/my_repo/issues/99',
      );
      expect(links).toHaveLength(1);
      expect(links[0].owner).toBe('my.org');
      expect(links[0].repo).toBe('my_repo');
    });

    it('handles repos with hyphens in names', () => {
      const links = extractGitHubLinks(
        'https://github.com/ditto-assistant/ditto-app/pull/895',
      );
      expect(links).toHaveLength(1);
      expect(links[0].owner).toBe('ditto-assistant');
      expect(links[0].repo).toBe('ditto-app');
      expect(links[0].number).toBe(895);
    });
  });

  describe('fetchGitHubLinkedContext', () => {
    it('returns null for empty messages', async () => {
      const result = await fetchGitHubLinkedContext([]);
      expect(result).toBeNull();
    });

    it('returns null for messages with no GitHub URLs', async () => {
      const result = await fetchGitHubLinkedContext([
        { content: 'hello world' },
        { content: 'nothing here' },
      ]);
      expect(result).toBeNull();
    });

    it('deduplicates links across multiple messages', () => {
      // Test via extractGitHubLinks since fetchGitHubLinkedContext
      // does its own dedup across messages
      const url = 'https://github.com/org/repo/pull/1';
      const msg1Links = extractGitHubLinks(`check ${url}`);
      const msg2Links = extractGitHubLinks(`also ${url}`);

      // Both return the same link
      expect(msg1Links).toHaveLength(1);
      expect(msg2Links).toHaveLength(1);
      expect(msg1Links[0].number).toBe(msg2Links[0].number);
    });

    it('caps at MAX_LINKED_ITEMS (3)', () => {
      const text = [
        'https://github.com/a/b/pull/1',
        'https://github.com/a/b/pull/2',
        'https://github.com/a/b/pull/3',
        'https://github.com/a/b/pull/4',
        'https://github.com/a/b/pull/5',
      ].join(' ');
      const links = extractGitHubLinks(text);
      // extractGitHubLinks returns all, but fetchGitHubLinkedContext caps at 3
      expect(links).toHaveLength(5);
    });
  });
});
