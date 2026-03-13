import { describe, expect, it } from 'bun:test';

import { describeImageUrl } from './image-cache.js';

describe('describeImageUrl', () => {
  it('drops query strings and fragments from absolute urls', () => {
    expect(
      describeImageUrl('https://example.test/avatar.png?token=secret#ignored'),
    ).toBe('https://example.test/avatar.png');
  });

  it('returns the original value for non-url strings', () => {
    expect(describeImageUrl('/avatars/local.png')).toBe('/avatars/local.png');
  });
});
