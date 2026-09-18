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
  querySelectorAll(sel) { return []; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = {};
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

  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
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

test('UI: Regular login flow with email and password for existing user', async () => {
  const fakeDoc = new FakeDocument();
  globalThis.document = fakeDoc;

  const authModal = fakeDoc.getElementById('auth-modal');
  const emailStep = fakeDoc.getElementById('auth-step-email');
  const loginStep = fakeDoc.getElementById('auth-step-login');
  const registerStep = fakeDoc.getElementById('auth-step-register');
  const emailInput = fakeDoc.getElementById('auth-email-input');
  const emailForm = fakeDoc.getElementById('form-auth-email');
  const passInput = fakeDoc.getElementById('auth-login-password');
  const loginForm = fakeDoc.getElementById('form-auth-login');
  const emailChip = fakeDoc.getElementById('auth-chip-email');

  let signedInUser = null;
  let reconnectedToken = null;
  let toastMsg = null;

  const mockAuth = {
    onChange: null,
    accessToken: null,
    displayName: 'RegularPlayer',
    async checkUserExists(email) {
      return email === 'player@example.com';
    },
    async signInWithPassword(email, password) {
      if (password === 'correctpass') {
        this.accessToken = 'jwt_test_token_123';
        signedInUser = { email };
        return { user: signedInUser };
      }
      throw new Error('Invalid login credentials');
    }
  };

  const mockNetwork = {
    setAccessToken(tok) {},
    async reconnectWithAuth(tok) {
      reconnectedToken = tok;
    }
  };

  const lobby = new LobbyView({
    auth: mockAuth,
    network: mockNetwork,
    showToast: (msg, isErr) => { toastMsg = msg; },
    showView: () => {}
  });

  lobby.setupAuthUi();

  // Open auth modal
  fakeDoc.getElementById('btn-header-sign-in').click();
  assert.equal(authModal.classList.contains('active'), true);
  assert.equal(emailStep.classList.contains('is-hidden'), false);

  // 1. Submit email for existing user
  emailInput.value = 'player@example.com';
  emailForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise(r => setTimeout(r, 10));

  // Should navigate to login step
  assert.equal(emailStep.classList.contains('is-hidden'), true);
  assert.equal(loginStep.classList.contains('is-hidden'), false);
  assert.equal(registerStep.classList.contains('is-hidden'), true);
  assert.equal(emailChip.textContent, 'player@example.com');

  // 2. Submit wrong password
  passInput.value = 'wrongpassword';
  loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise(r => setTimeout(r, 10));

  assert.match(toastMsg, /Invalid password/i);
  assert.equal(authModal.classList.contains('active'), true, 'Modal remains open on wrong password');
  assert.equal(signedInUser, null);

  // 3. Submit correct password
  passInput.value = 'correctpass';
  loginForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(signedInUser?.email, 'player@example.com');
  assert.equal(reconnectedToken, 'jwt_test_token_123');
  assert.equal(authModal.classList.contains('active'), false, 'Modal should close after successful regular login');
});

test('UI: Regular registration flow for new user', async () => {
  const fakeDoc = new FakeDocument();
  globalThis.document = fakeDoc;

  const authModal = fakeDoc.getElementById('auth-modal');
  const emailStep = fakeDoc.getElementById('auth-step-email');
  const loginStep = fakeDoc.getElementById('auth-step-login');
  const registerStep = fakeDoc.getElementById('auth-step-register');
  const emailInput = fakeDoc.getElementById('auth-email-input');
  const emailForm = fakeDoc.getElementById('form-auth-email');
  const regPassInput = fakeDoc.getElementById('auth-register-password');
  const regForm = fakeDoc.getElementById('form-auth-register');
  const regChip = fakeDoc.getElementById('auth-chip-email-reg');

  let signedUpUser = null;
  let reconnectedToken = null;

  const mockAuth = {
    onChange: null,
    accessToken: null,
    displayName: 'NewPlayer',
    async checkUserExists(email) {
      return false; // new user
    },
    async signUpWithPassword(email, password) {
      this.accessToken = 'jwt_new_token_456';
      signedUpUser = { email };
      return { user: signedUpUser };
    }
  };

  const mockNetwork = {
    setAccessToken(tok) {},
    async reconnectWithAuth(tok) {
      reconnectedToken = tok;
    }
  };

  const lobby = new LobbyView({
    auth: mockAuth,
    network: mockNetwork,
    showToast: () => {},
    showView: () => {}
  });

  lobby.setupAuthUi();

  // Open modal
  fakeDoc.getElementById('btn-header-sign-in').click();

  // Submit email for new user
  emailInput.value = 'newbie@example.com';
  emailForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise(r => setTimeout(r, 10));

  // Should transition to register step
  assert.equal(loginStep.classList.contains('is-hidden'), true);
  assert.equal(registerStep.classList.contains('is-hidden'), false);
  assert.equal(regChip.textContent, 'newbie@example.com');

  // Submit registration password
  regPassInput.value = 'supersecret123';
  regForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(signedUpUser?.email, 'newbie@example.com');
  assert.equal(reconnectedToken, 'jwt_new_token_456');
  assert.equal(authModal.classList.contains('active'), false, 'Modal should close after signup');
});

