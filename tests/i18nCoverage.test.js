/**
 * English-only UI: no language switcher and no Romanian copy in the client.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROMANIAN_TEXT = /[ăâîșțĂÂÎȘȚ]/;

describe('UX-02 English-only copy', () => {
  it('has no RO/EN switcher and no Romanian text in index.html', () => {
    const html = readFileSync(join(root, 'public/index.html'), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.equal(/lang-ro|lang-en|lang-selector/.test(html), false);
    assert.equal(ROMANIAN_TEXT.test(html), false);
  });

  it('does not ship a Romanian translation dictionary', () => {
    const src = readFileSync(join(root, 'public/js/i18n.js'), 'utf8');
    assert.equal(/\bro:\s*\{/.test(src), false);
    assert.equal(/setLang\s*\(/.test(src), false);
    assert.match(src, /export const STRINGS/);
  });

  it('has no leftover Romanian copy in client JavaScript', () => {
    const leftovers = [];
    for (const name of readdirSync(join(root, 'public/js'))) {
      if (!name.endsWith('.js')) continue;
      const src = readFileSync(join(root, 'public/js', name), 'utf8');
      if (ROMANIAN_TEXT.test(src) || /\(Ai /.test(src) || /\+1 carte/.test(src)) {
        leftovers.push(name);
      }
    }
    assert.deepEqual(leftovers, [], `Romanian leftovers in: ${leftovers.join(', ')}`);
  });
});
