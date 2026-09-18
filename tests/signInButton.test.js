import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LobbyView } from '../public/js/components/LobbyView.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class FakeElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    const set = new Set();
    this.classList = {
      add: (cls) => set.add(cls),
      remove: (cls) => set.delete(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (set.has(cls)) set.delete(cls);
          else set.add(cls);
        } else if (force) {
          set.add(cls);
        } else {
          set.delete(cls);
        }
      },
      contains: (cls) => set.has(cls)
    };
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.disabled = false;
  }

  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  dispatchEvent(event) {
    const list = this.listeners[event.type || event] || [];
    for (const fn of list) {
      fn(event);
    }
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

  focus() {}
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      this.elements.set(id, new FakeElement(id));
    }
    return this.elements.get(id);
  }

  querySelectorAll(selector) {
    return [];
  }
}

test('UI: Sign in button in header opens auth modal', () => {
  const fakeDoc = new FakeDocument();
  globalThis.document = fakeDoc;

  const authModal = fakeDoc.getElementById('auth-modal');
  const signInBtn = fakeDoc.getElementById('btn-header-sign-in');
  const closeBtn = fakeDoc.getElementById('btn-close-auth-modal');
  const emailStep = fakeDoc.getElementById('auth-step-email');
  const loginStep = fakeDoc.getElementById('auth-step-login');

  let profileOpened = false;
  const lobby = new LobbyView({
    auth: { onChange: null, accessToken: null },
    showToast: () => {},
    showView: () => {}
  });
  lobby.openProfilePage = () => { profileOpened = true; };

  lobby.setupAuthUi();

  // Initially modal is not active
  assert.equal(authModal.classList.contains('active'), false);

  // Click Sign In button in header
  signInBtn.click();
  assert.equal(authModal.classList.contains('active'), true, 'Auth modal must be opened when clicking btn-header-sign-in');
  assert.equal(emailStep.classList.contains('is-hidden'), false, 'Email step should not be hidden');

  // Close modal via close button
  closeBtn.click();
  assert.equal(authModal.classList.contains('active'), false, 'Auth modal must be closed when clicking close button');

  // Open modal via guest sign in button
  const guestSignInBtn = fakeDoc.getElementById('btn-profile-guest-signin');
  guestSignInBtn.click();
  assert.equal(authModal.classList.contains('active'), true, 'Auth modal must open from guest profile sign in button');

  // Close modal by clicking backdrop overlay
  authModal.dispatchEvent({ type: 'click', target: authModal });
  assert.equal(authModal.classList.contains('active'), false, 'Auth modal must close when clicking backdrop');

  // Click header profile button
  const headerProfileBtn = fakeDoc.getElementById('header-user-profile');
  headerProfileBtn.click();
  assert.equal(profileOpened, true, 'header-user-profile must open the profile page');
});

test('HTML: index.html contains required auth and sign-in button IDs', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="btn-header-sign-in"/);
  assert.match(html, /id="header-user-profile"/);
  assert.match(html, /id="btn-close-auth-modal"/);
  assert.match(html, /id="auth-modal"/);
  assert.match(html, /id="btn-sign-in-google"/);
  assert.match(html, /id="auth-step-email"/);
  assert.match(html, /id="btn-auth-continue"/);
  assert.match(html, /id="auth-step-login"/);
  assert.match(html, /id="btn-auth-forgot-password"/);
});
