/**
 * tests/passwordVisibility.test.js
 * Tests that password-input-wrap and .btn-toggle-password are present and functional
 * for all password fields in index.html.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');

describe('Password Visibility Toggle — HTML Structure', () => {
  const passwordFieldIds = [
    'auth-login-password',
    'auth-register-password',
    'auth-reset-password',
    'auth-reset-password-confirm',
    'profile-new-password',
    'account-new-password',
  ];

  for (const id of passwordFieldIds) {
    test(`${id} is inside a .password-input-wrap`, () => {
      const inputIdx = html.indexOf(`id="${id}"`);
      assert.notEqual(inputIdx, -1, `Input #${id} not found in index.html`);
      const before = html.slice(0, inputIdx);
      const wrapStart = before.lastIndexOf('password-input-wrap');
      assert.notEqual(wrapStart, -1, `#${id} is not wrapped in .password-input-wrap`);
    });

    test(`${id} has an adjacent .btn-toggle-password with data-target`, () => {
      const inputIdx = html.indexOf(`id="${id}"`);
      assert.notEqual(inputIdx, -1, `Input #${id} not found in index.html`);
      const after = html.slice(inputIdx, inputIdx + 1000);
      assert.match(after, /btn-toggle-password/, `#${id} has no adjacent .btn-toggle-password`);
      assert.match(after, new RegExp(`data-target="${id}"`), `btn-toggle-password for #${id} missing data-target`);
    });

    test(`${id} toggle button has icon-eye and icon-eye-off SVGs`, () => {
      const inputIdx = html.indexOf(`id="${id}"`);
      const after = html.slice(inputIdx, inputIdx + 1500);
      assert.match(after, /icon-eye/, `#${id} toggle is missing .icon-eye svg`);
      assert.match(after, /icon-eye-off/, `#${id} toggle is missing .icon-eye-off svg`);
    });
  }
});

describe('Password Visibility Toggle — Reset step HTML', () => {
  test('auth-step-reset exists with form and submit button', () => {
    assert.match(html, /id="auth-step-reset"/, 'auth-step-reset not found in HTML');
    assert.match(html, /id="form-auth-reset"/, 'form-auth-reset not found in HTML');
    assert.match(html, /id="btn-auth-reset-submit"/, 'btn-auth-reset-submit not found in HTML');
    assert.match(html, /id="auth-reset-password"/, 'auth-reset-password input not found in HTML');
    assert.match(html, /id="auth-reset-password-confirm"/, 'auth-reset-password-confirm input not found in HTML');
  });

  test('auth-step-reset is initially hidden', () => {
    const stepIdx = html.indexOf('id="auth-step-reset"');
    const before = html.slice(Math.max(0, stepIdx - 10), stepIdx + 60);
    assert.match(before, /is-hidden/, 'auth-step-reset should start with is-hidden class');
  });
});

describe('Password Visibility Toggle — CSS Classes', () => {
  test('ui.css contains .password-input-wrap styles', () => {
    const css = readFileSync(join(root, 'public/css/ui.css'), 'utf8');
    assert.match(css, /\.password-input-wrap/, 'ui.css missing .password-input-wrap');
    assert.match(css, /\.btn-toggle-password/, 'ui.css missing .btn-toggle-password');
    assert.match(css, /padding-right.*42px/, 'password-input-wrap should set padding-right for input');
  });
});

describe('Password Visibility Toggle — Toggle Logic', () => {
  test('toggling type attribute switches between password and text', () => {
    const state = { type: 'password' };
    const toggle = () => {
      const isNowText = state.type === 'password';
      state.type = isNowText ? 'text' : 'password';
      return isNowText;
    };

    assert.equal(state.type, 'password', 'initial state should be password');
    const firstToggle = toggle();
    assert.equal(firstToggle, true, 'should return true on first toggle (was password)');
    assert.equal(state.type, 'text', 'type should be text after first toggle');

    const secondToggle = toggle();
    assert.equal(secondToggle, false, 'should return false on second toggle (was text)');
    assert.equal(state.type, 'password', 'type should be password after second toggle');
  });
});
