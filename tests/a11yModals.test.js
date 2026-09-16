import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');

describe('UX-06 accessibility', () => {
  it('gives every modal overlay dialog semantics', () => {
    const overlays = [...html.matchAll(/<div id="[^"]+" class="modal-overlay"/g)].map(m => m[0]);
    assert.ok(overlays.length >= 8, 'expected the in-game modal overlays');
    const missing = [...html.matchAll(/<div[^>]*class="modal-overlay"[^>]*>/g)]
      .map(m => m[0])
      .filter(tag => !/role="dialog"/.test(tag) || !/aria-modal="true"/.test(tag));
    assert.deepEqual(missing, [], `Overlays missing dialog role:\n${missing.join('\n')}`);
  });

  it('includes an Aqueduct chooser modal for any 1 resource', () => {
    assert.match(html, /id="aqueduct-modal"/);
    assert.match(html, /Aqueduct: Choose 1 Resource/);
    assert.match(html, /data-res="wood"/);
    assert.match(html, /data-res="ore"/);
  });
});
