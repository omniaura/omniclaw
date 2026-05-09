import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

describe('agent container crawl tooling', () => {
  it('keeps crawl install scripts in the container build context', () => {
    const dockerignore = read('container/.dockerignore');

    expect(dockerignore).toContain('!gitcrawl.sh');
    expect(dockerignore).toContain('!discrawl.sh');
  });

  it('installs pinned gitcrawl and discrawl versions in the base image', () => {
    const dockerfile = read('container/Dockerfile.base');

    expect(dockerfile).toContain('ARG GITCRAWL_VERSION=v0.2.1');
    expect(dockerfile).toContain('ARG DISCRAWL_VERSION=v0.7.0');
    expect(dockerfile).toContain('COPY gitcrawl.sh discrawl.sh /tmp/');
    expect(dockerfile).toContain('/tmp/gitcrawl.sh');
    expect(dockerfile).toContain('/tmp/discrawl.sh');
  });

  it('configures gitcrawl as the gh shim while preserving the real gh fallback', () => {
    const dockerfile = read('container/Dockerfile.base');
    const script = read('container/gitcrawl.sh');

    expect(dockerfile).toContain('ENV GITCRAWL_GH_PATH=/usr/bin/gh');
    expect(script).toContain('github.com/openclaw/gitcrawl/cmd/gitcrawl');
    expect(script).toContain(
      'ln -sf "$INSTALL_DIR/gitcrawl" "$INSTALL_DIR/gh"',
    );
    expect(script).toContain(
      'ln -sf "$INSTALL_DIR/gitcrawl" "$INSTALL_DIR/gitcrawl-gh"',
    );
  });

  it('installs the discrawl command from the openclaw module', () => {
    const script = read('container/discrawl.sh');

    expect(script).toContain('github.com/openclaw/discrawl/cmd/discrawl');
    expect(script).toContain(
      'install -m 0755 "$tmp_gobin/discrawl" "$INSTALL_DIR/discrawl"',
    );
  });
});
