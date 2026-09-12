/**
 * Static i18n coverage: index.html must not leave Romanian copy
 * without a data-i18n / data-i18n-title / data-i18n-placeholder binding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROMANIAN_TEXT = /[ăâîșțĂÂÎȘȚ]/;

function stripWhitelisted(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
}

describe('UX-02 i18n coverage', () => {
  it('binds every Romanian visible string in index.html to a data-i18n attribute', () => {
    const html = stripWhitelisted(readFileSync(join(root, 'public/index.html'), 'utf8'));
    const leftovers = [];
    const tagRe = /<([a-zA-Z][\w:-]*)([^>]*)>([^<]*)/g;
    let match;
    while ((match = tagRe.exec(html))) {
      const attrs = match[2] || '';
      const text = (match[3] || '').trim();
      if (!text || !ROMANIAN_TEXT.test(text)) continue;
      if (/\bdata-i18n(?:-title|-placeholder)?\s*=/.test(attrs)) continue;
      leftovers.push(`${match[1]}: ${text.slice(0, 80)}`);
    }

    const titleRe = /\stitle="([^"]*[ăâîșțĂÂÎȘȚ][^"]*)"/g;
    while ((match = titleRe.exec(html))) {
      const around = html.slice(Math.max(0, match.index - 180), match.index);
      if (!/data-i18n-title\s*=/.test(around.split('<').pop() || '')) {
        leftovers.push(`title="${match[1]}"`);
      }
    }

    assert.deepEqual(leftovers, [], `Unbound Romanian text:\n${leftovers.join('\n')}`);
  });
});
