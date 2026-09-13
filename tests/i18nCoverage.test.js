/**
 * English-only UI: no language switcher and no Romanian copy in the client shell.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
});
