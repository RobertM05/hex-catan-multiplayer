import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');

describe('UX-03 inline style cleanup', () => {
  it('keeps static presentation styles out of index.html', () => {
    const matches = html.match(/\sstyle="/g) || [];
    assert.equal(matches.length, 0, `Found ${matches.length} inline style attributes`);
  });
});
