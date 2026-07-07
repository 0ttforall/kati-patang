// ==UserScript==
// @name         Adobe Express Automator
// @namespace    https://github.com/0ttforall/kati-patang
// @version      0.2.5
// @description  Distributed Adobe Express image generation worker
// @author       0ttforall
// @match        https://new.express.adobe.com/*
// @match        https://express.adobe.com/*
// @match        https://login.microsoftonline.com/*
// @match        https://*.services.adobe.com/*
// @match        https://*.adobe.com/*
// @match        https://login.live.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/0ttforall/kati-patang/main/automator.user.js
// @downloadURL  https://raw.githubusercontent.com/0ttforall/kati-patang/main/automator.user.js
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  'use strict';

  // ===========================================================
  // CONFIG — Supabase project URL + publishable (client) API key.
  // Project Settings → API Keys → use the "Publishable" key
  // (the new equivalent of the legacy "anon" key). NEVER paste
  // the "Secret" key here — it bypasses RLS.
  // ===========================================================
  const SUPABASE_URL             = 'https://poswjjugynmxavjwfnjh.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_bzUJZNq1Pg48gvOJjFahBQ_ACpDXS95';

  // Prompt used for image generation. Change as needed.
  const TARGET_PROMPT = 'peacock and peahen';
  const TARGET_URL = `https://new.express.adobe.com/new?prompt=${encodeURIComponent(TARGET_PROMPT)}&aspectRatio=landscape&action=text+to+image&width=1024&height=768&intent=general&media=media`;

  const POLL_MS              = 500;
  const MAX_LOGIN_ITERATIONS = 30;
  const NO_WORK_WAIT_MS      = 30_000;
  const DOWNLOAD_WAIT_MS     = 60_000;

  // ===========================================================
  // Persisted state keys (Tampermonkey GM_setValue)
  // ===========================================================
  const KEY_SESSION       = 'supabase_session';
  const KEY_RUNNING       = 'is_running';
  const KEY_ACCOUNT       = 'current_account';
  const KEY_STARTED_AT    = 'account_started_at';
  const KEY_PHASE         = 'phase';
  const KEY_LOG           = 'log_tail';
  const KEY_DOWNLOAD_DONE = 'download_done';

  // ===========================================================
  // Tiny utilities
  // ===========================================================
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
  const nowSec = ()   => Date.now() / 1000;

  function log(msg) {
    console.log('[automator]', msg);
    const tail = GM_getValue(KEY_LOG, []);
    tail.push({ t: new Date().toISOString(), msg: String(msg) });
    while (tail.length > 80) tail.shift();
    GM_setValue(KEY_LOG, tail);
    renderLog();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Adobe renders "Open in editor" while the image is still generating
  // but marks it disabled. Spectrum web components use the `disabled`
  // attribute; some wrappers use `aria-disabled`. Check both, and walk
  // up to the closest button ancestor since findByText often returns
  // the text-bearing child rather than the button itself.
  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled === true) return false;
    if (el.hasAttribute && el.hasAttribute('disabled')) return false;
    const aria = el.getAttribute && el.getAttribute('aria-disabled');
    if (aria === 'true') return false;
    const btn = el.closest && el.closest(
      'button, sp-button, sp-action-button, sp-icon-button, [role="button"]'
    );
    if (btn && btn !== el) {
      if (btn.disabled) return false;
      if (btn.hasAttribute('disabled')) return false;
      if (btn.getAttribute('aria-disabled') === 'true') return false;
    }
    return true;
  }

  // Whether an element belongs to our own panel UI (excluded from
  // any "find on page" search so we don't click ourselves).
  function inOurPanel(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('#automator-panel');
  }

  // Walk the entire document AND every open shadowRoot recursively.
  // Adobe Express renders most of its toolbar inside Spectrum web
  // components, all of which use open shadow roots, so a plain
  // document.querySelectorAll('*') misses ~everything.
  function* deepWalk(root = document) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !node.querySelectorAll) continue;
      const all = node.querySelectorAll('*');
      for (const el of all) {
        yield el;
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
  }

  function deepQuery(selector) {
    for (const el of deepWalk()) {
      if (el.matches && el.matches(selector)) return el;
    }
    return null;
  }

  function deepQueryAll(selector) {
    const out = [];
    for (const el of deepWalk()) {
      if (el.matches && el.matches(selector)) out.push(el);
    }
    return out;
  }

  // Scans every element (incl. Spectrum components in shadow DOM)
  // and returns the *smallest* (deepest) element whose visible text matches.
  // Excludes our own panel descendants.
  function findByText(text, exact = true) {
    const matches = [];
    for (const el of deepWalk()) {
      if (!isVisible(el)) continue;
      if (inOurPanel(el)) continue;
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (exact ? t === text : t.includes(text)) matches.push(el);
    }
    matches.sort((a, b) =>
      (a.querySelectorAll ? a.querySelectorAll('*').length : 0) -
      (b.querySelectorAll ? b.querySelectorAll('*').length : 0)
    );
    return matches[0] || null;
  }

  async function waitFor(predicate, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(POLL_MS);
    }
    throw new Error('Timeout waiting for element');
  }

  // React-safe input fill
  function fillInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    }
  }

  // Navigate without the browser's "Leave site?" dialog.
  // Adobe Express registers a beforeunload handler (unsaved changes).
  // We register one too, in the capture phase, that nukes the prompt
  // before Adobe's listener runs.
  function safeNavigate(url) {
    try {
      window.onbeforeunload = null;
      const swallow = (e) => {
        e.stopImmediatePropagation();
        delete e.returnValue;
        e.returnValue = undefined;
      };
      window.addEventListener('beforeunload', swallow, { capture: true });
      window.addEventListener('pagehide',     swallow, { capture: true });
    } catch {}
    location.href = url;
  }

  // True if we appear to be signed into Adobe (so a UI logout makes sense).
  // False means we're already on a login page, or no auth markers are
  // present — in which case we skip logout entirely.
  function appearsLoggedInToAdobe() {
    if (!location.hostname.includes('adobe.com')) return false;
    // On any auth subdomain we are by definition signed out / in-flight
    if (/(auth|adobeid|login|ims)\./i.test(location.hostname)) return false;
    // If a Sign in / Log in CTA is visible, treated as signed out
    if (findByText('Sign in', true) || findByText('Log in', true)) return false;
    // Look for any profile/avatar marker
    const markers = [
      '[aria-label*="Account" i]',
      '[aria-label*="Profile" i]',
      '[data-testid*="profile" i]',
      '[data-testid*="avatar" i]',
      'sp-avatar',
    ];
    for (const sel of markers) {
      const el = deepQuery(sel);
      if (el && isVisible(el) && !inOurPanel(el)) return true;
    }
    return false;
  }

  // Click Adobe's profile/avatar icon (top-right) → "Sign out", then wait
  // until the page actually reflects a signed-out state (URL flips to an
  // auth subdomain, or logged-in markers disappear). Returns true only if
  // the sign-out chain completed. Never touches cookies — Adobe's own
  // logout endpoints are trusted to clear the session properly.
  async function adobeUiLogout() {
    if (!location.hostname.includes('adobe.com')) return false;
    log('Attempting Adobe UI logout');

    // Step 1 — find a profile/avatar trigger anywhere in the DOM (incl. shadow).
    const profileSelectors = [
      '[aria-label*="Account" i]',
      '[aria-label*="Profile" i]',
      '[aria-label*="profile menu" i]',
      '[data-testid*="profile" i]',
      '[data-testid*="account" i]',
      '[data-testid*="avatar" i]',
      'sp-action-button[aria-label*="Account" i]',
      'sp-avatar',
      'img[alt*="profile" i]',
    ];
    let profile = null;
    for (const sel of profileSelectors) {
      const cand = deepQuery(sel);
      if (cand && isVisible(cand) && !inOurPanel(cand)) { profile = cand; break; }
    }
    if (!profile) {
      log('Profile icon not found — cannot UI-logout');
      return false;
    }
    log(`Clicking profile (${profile.tagName.toLowerCase()})`);
    profile.click();
    await sleep(2000);

    // Step 2 — Sign out in the dropdown.
    const signOut =
      findByText('Sign out', true) ||
      findByText('Sign Out', true) ||
      findByText('Log out',  true) ||
      findByText('Log Out',  true) ||
      findByText('Logout',   true);
    if (!signOut) {
      log('Sign out option not visible after profile click');
      return false;
    }
    log('Clicking Sign out');
    signOut.click();

    // Step 3 — wait for the sign-out to actually take effect. Adobe
    // redirects through auth.services.adobe.com and eventually lands
    // on a signed-out state. Poll until either the URL moves to an
    // auth host or the logged-in markers stop appearing.
    try {
      await waitFor(() => {
        if (/(auth|adobeid|login|ims)\./i.test(location.hostname)) return true;
        return !appearsLoggedInToAdobe();
      }, 15_000);
      log('Sign-out confirmed');
      return true;
    } catch {
      log('Sign-out did not confirm within 15s');
      return false;
    }
  }

  // ===========================================================
  // Supabase REST client (via GM_xmlhttpRequest for CORS bypass)
  // ===========================================================
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload:   r => resolve(r),
        onerror:  e => reject(e),
        ontimeout: () => reject(new Error('timeout'))
      });
    });
  }

  async function supaSignIn(email, password) {
    const r = await gmRequest({
      method: 'POST',
      url:    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      headers: {
        'apikey':       SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({ email, password })
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Sign-in failed: ${r.responseText}`);
    }
    const body = JSON.parse(r.responseText);
    GM_setValue(KEY_SESSION, {
      access_token:  body.access_token,
      refresh_token: body.refresh_token,
      user_id:       body.user.id,
      user_email:    body.user.email,
      expires_at:    Date.now() + body.expires_in * 1000
    });
  }

  async function supaRefresh() {
    const sess = GM_getValue(KEY_SESSION);
    if (!sess) return null;
    const r = await gmRequest({
      method: 'POST',
      url:    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      headers: { 'apikey': SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      data:   JSON.stringify({ refresh_token: sess.refresh_token })
    });
    if (r.status < 200 || r.status >= 300) {
      GM_deleteValue(KEY_SESSION);
      return null;
    }
    const body = JSON.parse(r.responseText);
    GM_setValue(KEY_SESSION, {
      access_token:  body.access_token,
      refresh_token: body.refresh_token,
      user_id:       body.user.id,
      user_email:    body.user.email,
      expires_at:    Date.now() + body.expires_in * 1000
    });
    return body.access_token;
  }

  async function supaToken() {
    const sess = GM_getValue(KEY_SESSION);
    if (!sess) return null;
    if (Date.now() > sess.expires_at - 60_000) return await supaRefresh();
    return sess.access_token;
  }

  async function supaRpc(fn, payload = {}) {
    const token = await supaToken();
    if (!token) throw new Error('Not signed in');
    const r = await gmRequest({
      method: 'POST',
      url:    `${SUPABASE_URL}/rest/v1/rpc/${fn}`,
      headers: {
        'apikey':        SUPABASE_PUBLISHABLE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json'
      },
      data: JSON.stringify(payload)
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`RPC ${fn}: ${r.status} ${r.responseText}`);
    }
    return r.responseText ? JSON.parse(r.responseText) : null;
  }

  const claimNext   = ()                            => supaRpc('claim_next_account');
  const markDone    = (id, duration)                => supaRpc('mark_account_done',   { p_id: id, p_duration: duration });
  const markFailed  = (id, stage, error, duration)  => supaRpc('mark_account_failed', { p_id: id, p_stage: stage, p_error: String(error).slice(0, 500), p_duration: duration });

  // ===========================================================
  // Download detection — observe the final Download click so the
  // editor flow can stop waiting. We do NOT modify the anchor, do
  // NOT preventDefault, and do NOT re-issue via GM_download; the
  // browser's own download flow handles the save with Adobe's
  // default filename, straight into the user's Downloads folder.
  // ===========================================================
  function setupDownloadHook() {
    // (1) Bubbled clicks on attached <a download>/img anchors.
    const handler = (e) => {
      const acc = GM_getValue(KEY_ACCOUNT);
      if (!acc) return;
      const a = e.target.closest && e.target.closest('a[download], a[href*=".png"], a[href*=".jpg"], a[href*=".jpeg"]');
      if (!a || !a.href || a.href.startsWith('javascript:')) return;
      log('Download click detected (bubbled)');
      GM_setValue(KEY_DOWNLOAD_DONE, true);
    };
    document.addEventListener('click', handler, true);

    // (2) Programmatic a.click() on unattached anchors. Adobe's SPA
    // creates <a href="blob:..." download> in memory and calls .click()
    // without ever inserting it into the DOM — the resulting click
    // event never bubbles to `document`, so the listener above misses
    // it entirely. Wrap the prototype method so we still see it.
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        const acc = GM_getValue(KEY_ACCOUNT);
        if (acc) {
          const href = this.href || '';
          const looksLikeDownload =
            this.hasAttribute('download') ||
            href.startsWith('blob:') ||
            /\.(png|jpe?g|pdf|svg|gif|webp)(\?|$)/i.test(href);
          if (looksLikeDownload && !href.startsWith('javascript:')) {
            log(`Download click detected (a.click, ${href.slice(0, 40)})`);
            GM_setValue(KEY_DOWNLOAD_DONE, true);
          }
        }
      } catch {}
      return originalClick.apply(this, arguments);
    };
  }

  // ===========================================================
  // Floating panel UI
  // ===========================================================
  let panelEl = null;
  let logEl   = null;
  let statsEl = null;

  function injectStyle() {
    GM_addStyle(`
      #automator-panel {
        position: fixed; bottom: 12px; left: 12px; z-index: 2147483647;
        background: #111; color: #eee; font: 12px/1.4 system-ui, sans-serif;
        border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        min-width: 280px; max-width: 320px; padding: 12px;
        opacity: 0.92;
      }
      #automator-panel:hover { opacity: 1; }
      #automator-panel h1 { font-size: 13px; margin: 0 0 8px 0; color: #fff; }
      #automator-panel .row { margin: 4px 0; }
      #automator-panel input {
        width: 100%; box-sizing: border-box;
        background: #222; color: #eee; border: 1px solid #444;
        padding: 6px 8px; border-radius: 4px; margin: 2px 0 6px 0;
        font: inherit;
      }
      #automator-panel button {
        background: #4f8; color: #111; border: 0; padding: 6px 12px;
        border-radius: 4px; cursor: pointer; font-weight: 600;
      }
      #automator-panel button.danger    { background: #f55; color: #fff; }
      #automator-panel button.secondary { background: #555; color: #fff; }
      #automator-log {
        margin-top: 8px; max-height: 160px; overflow-y: auto;
        background: #000; padding: 6px; border-radius: 4px;
        font: 10px/1.3 ui-monospace, monospace; color: #9c9;
      }
      #automator-log div { margin: 1px 0; word-break: break-all; }
      #automator-panel .stats { color: #8cf; font-size: 11px; }
      #automator-panel .err   { color: #f88; font-size: 11px; }
    `);
  }

  function renderPanel() {
    if (panelEl) panelEl.remove();
    panelEl = document.createElement('div');
    panelEl.id = 'automator-panel';

    const sess = GM_getValue(KEY_SESSION);
    if (!sess) {
      panelEl.innerHTML = `
        <h1>Adobe Automator</h1>
        <div class="row">Sign in to start.</div>
        <input id="aut-email" type="email"    placeholder="email" autocomplete="off" />
        <input id="aut-pass"  type="password" placeholder="password" autocomplete="off" />
        <div class="row">
          <button id="aut-signin">Sign in</button>
          <span id="aut-msg" class="err"></span>
        </div>
      `;
      document.documentElement.appendChild(panelEl);
      panelEl.querySelector('#aut-signin').onclick = async () => {
        const msg = panelEl.querySelector('#aut-msg');
        msg.textContent = '...';
        try {
          await supaSignIn(
            panelEl.querySelector('#aut-email').value.trim(),
            panelEl.querySelector('#aut-pass').value
          );
          renderPanel();
        } catch (e) {
          msg.textContent = 'Invalid credentials';
        }
      };
      return;
    }

    const running = GM_getValue(KEY_RUNNING, false);
    const acc     = GM_getValue(KEY_ACCOUNT);
    panelEl.innerHTML = `
      <h1>Adobe Automator</h1>
      <div class="row">Hi ${sess.user_email}</div>
      <div class="row stats" id="aut-stats">—</div>
      <div class="row">${acc ? `Current: <b>${acc.email}</b>` : 'Idle'}</div>
      <div class="row">
        <button id="aut-toggle">${running ? 'Pause' : 'Start'}</button>
        <button id="aut-signout" class="secondary">Sign out</button>
      </div>
      <div id="automator-log"></div>
    `;
    document.documentElement.appendChild(panelEl);
    logEl   = panelEl.querySelector('#automator-log');
    statsEl = panelEl.querySelector('#aut-stats');

    panelEl.querySelector('#aut-toggle').onclick = () => {
      const r = !GM_getValue(KEY_RUNNING, false);
      GM_setValue(KEY_RUNNING, r);
      renderPanel();
      if (r) drive();
    };
    panelEl.querySelector('#aut-signout').onclick = () => {
      GM_deleteValue(KEY_SESSION);
      GM_setValue(KEY_RUNNING, false);
      renderPanel();
    };
    renderLog();
    refreshStats();
  }

  function escapeHtml(s) {
    return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  function renderLog() {
    if (!logEl) return;
    const tail = GM_getValue(KEY_LOG, []);
    logEl.innerHTML = tail.slice(-30).map(e =>
      `<div>${e.t.slice(11, 19)} ${escapeHtml(e.msg)}</div>`
    ).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function refreshStats() {
    try {
      const token = await supaToken();
      if (!token) return;
      const sess = GM_getValue(KEY_SESSION);
      const r = await gmRequest({
        method: 'GET',
        url:    `${SUPABASE_URL}/rest/v1/worker_stats?user_id=eq.${sess.user_id}&select=completed,failed,in_progress`,
        headers: { 'apikey': SUPABASE_PUBLISHABLE_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (r.status < 200 || r.status >= 300) return;
      const rows = JSON.parse(r.responseText);
      const me   = rows[0] || { completed: 0, failed: 0, in_progress: 0 };
      if (statsEl) statsEl.textContent = `Mine — done ${me.completed} · failed ${me.failed} · active ${me.in_progress}`;
    } catch {}
  }

  // ===========================================================
  // Automation runner
  // ===========================================================
  let driveLock = false;

  async function drive() {
    if (driveLock) return;
    driveLock = true;
    try {
      while (GM_getValue(KEY_RUNNING, false)) {
        const acc = GM_getValue(KEY_ACCOUNT);
        if (!acc) {
          await claimAndLaunch();
          if (!GM_getValue(KEY_ACCOUNT)) {
            await sleep(NO_WORK_WAIT_MS);
            continue;
          }
          // claimAndLaunch navigates; this page will be destroyed
          return;
        }
        const handled = await handleCurrentPage();
        if (!handled) return; // navigation expected
        // Loop back to claim next
      }
    } catch (e) {
      log(`drive error: ${e.message || e}`);
    } finally {
      driveLock = false;
    }
  }

  async function claimAndLaunch() {
    log('Claiming next account…');
    try {
      const row = await claimNext();
      const a   = Array.isArray(row) ? row[0] : row;
      if (!a || !a.id) {
        log('No pending accounts — sleeping');
        return;
      }
      log(`Claimed ${a.email} (id ${a.id})`);
      GM_setValue(KEY_ACCOUNT,       { id: a.id, email: a.email, password: a.password });
      GM_setValue(KEY_STARTED_AT,    nowSec());
      GM_setValue(KEY_DOWNLOAD_DONE, false);
      GM_setValue(KEY_PHASE,         'login');
      // Only bother with logout if a previous session looks active.
      // Cookies are never wiped — Adobe's own sign-out flow is the
      // only mechanism used to end a session.
      if (appearsLoggedInToAdobe()) {
        const ok = await adobeUiLogout();
        if (!ok) {
          log('UI logout failed — aborting claim to avoid wrong-session run');
          try { await markFailed(a.id, 'logout', 'UI logout failed', 0); } catch {}
          GM_setValue(KEY_ACCOUNT, null);
          GM_setValue(KEY_PHASE,   'login');
          return;
        }
      } else {
        log('Not signed in — skipping logout');
      }
      safeNavigate('https://new.express.adobe.com/');
    } catch (e) {
      log(`Claim failed: ${e.message || e}`);
    }
  }

  async function handleCurrentPage() {
    const host = location.hostname;
    if (host.includes('login.microsoftonline.com')) return await handleMicrosoftLogin();
    if (host.includes('auth.services.adobe.com'))   return await handleAdobeAuth();
    if (host.includes('express.adobe.com'))         return await handleExpress();
    return false;
  }

  // "Keep me signed in?" detection. Microsoft changes the markup
  // periodically — current variants:
  //   <button id="idBtn_Back">No</button>                 (modern)
  //   <input  id="idBtn_Back" type="button" value="No">   (legacy)
  // Only treat a button as the KMSI "No" when "Stay signed in" text
  // is present on the page, to avoid false positives elsewhere.
  function findKmsiNoButton() {
    if (!/stay signed in/i.test(document.body.innerText || '')) return null;
    const candidates = [
      document.querySelector('button#idBtn_Back'),
      document.querySelector('input#idBtn_Back'),
      document.querySelector('button[data-report-event="Signin_Submit_Cancel"]'),
      document.querySelector('input[value="No"]'),
      findByText('No', true),
    ];
    for (const c of candidates) if (c && isVisible(c)) return c;
    return null;
  }

  // Generic login loop — works on Adobe auth, MS login, and any login
  // form Express might briefly show. Idempotent: does nothing if no
  // login inputs are present.
  async function runLoginLoop(acc, hostLabel) {
    log(`Login loop on ${hostLabel}`);
    for (let i = 0; i < MAX_LOGIN_ITERATIONS; i++) {
      if (!GM_getValue(KEY_RUNNING, false)) return false;

      // Handle KMSI FIRST — before any Enter / submit action that
      // might inadvertently activate the default ("Yes") button.
      const noBtn = findKmsiNoButton();
      if (noBtn) {
        log('Clicking No on "Stay signed in"');
        noBtn.click();
        await sleep(3000);
        continue;
      }

      const emailInput = document.querySelector('input[type="email"]');
      if (emailInput && isVisible(emailInput) && !emailInput.value) {
        log('Filling email');
        fillInput(emailInput, acc.email);
        await sleep(300);
        const next =
          findByText('Next',     true) ||
          findByText('Continue', true) ||
          document.querySelector('input[type="submit"]') ||
          document.querySelector('button[type="submit"]');
        if (next) next.click(); else pressEnter(emailInput);
        await sleep(3000);
        continue;
      }

      const pwInput = document.querySelector('input[type="password"]');
      if (pwInput && isVisible(pwInput) && !pwInput.value) {
        log('Filling password');
        fillInput(pwInput, acc.password);
        await sleep(300);
        const signin =
          findByText('Sign in',  true) ||
          findByText('Continue', true) ||
          document.querySelector('input[type="submit"]') ||
          document.querySelector('button[type="submit"]');
        if (signin) signin.click(); else pressEnter(pwInput);
        await sleep(3000);
        continue;
      }

      await sleep(700);
    }
    return true;
  }

  async function handleMicrosoftLogin() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;
    return await runLoginLoop(acc, 'Microsoft');
  }

  async function handleAdobeAuth() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;
    return await runLoginLoop(acc, 'Adobe auth');
  }

  async function handleExpress() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;

    // Give redirects a chance to settle before deciding state
    await sleep(2500);

    // If a login form is still visible on Express, drive it
    const emailInput = document.querySelector('input[type="email"]');
    const pwInput    = document.querySelector('input[type="password"]');
    if ((emailInput && isVisible(emailInput)) || (pwInput && isVisible(pwInput))) {
      log('Login form on Express — driving login');
      return await runLoginLoop(acc, 'Express');
    }

    // If the page is offering "Sign in" / "Log in", click it so we get bounced to the auth flow
    const signInBtn = findByText('Sign in', true) || findByText('Log in', true);
    if (signInBtn) {
      log('Clicking Sign in to start auth flow');
      signInBtn.click();
      await sleep(3000);
      return false; // navigation expected
    }

    // Decide whether we're on a page where runEditorFlow can do useful
    // work, from the URL alone. Two shapes count:
    //   - the prompt URL itself (has ?prompt=…)
    //   - the editor sub-page Adobe navigates to after clicking Open in
    //     editor (path starts with /id/)
    // Anything else (bare /, /?postlogin=true, other landing pages) means
    // Adobe's auth flow dropped us at home. Re-navigate to TARGET_URL.
    // Deliberately NOT gated on KEY_PHASE — phase can be stale 'editor'
    // from a prior attempt that Adobe interrupted with an auth redirect,
    // which used to short-circuit this check and send runEditorFlow off
    // on the wrong URL.
    const onPromptUrl = location.search.includes('prompt=');
    const onEditorUrl = /^\/(id|design|edit)\//i.test(location.pathname);
    if (!onPromptUrl && !onEditorUrl) {
      log(`Not on prompt/editor URL (@${location.pathname}) — navigating to target prompt`);
      GM_setValue(KEY_PHASE, 'login'); // clear any stale 'editor' phase
      safeNavigate(TARGET_URL);
      return false;
    }

    return await runEditorFlow();
  }

  async function runEditorFlow() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;
    log(`Editor flow @ ${location.pathname}${location.search.slice(0, 60)}`);
    // Now that we're actually running the editor flow, mark the phase
    // so a mid-flow SPA navigation (e.g. after clicking "Open in editor")
    // doesn't cause handleExpress to bounce us back to the prompt URL.
    GM_setValue(KEY_PHASE, 'editor');
    try {
      // Open in editor — wait until the button is BOTH visible AND enabled.
      // While generation is in progress Adobe renders the button disabled;
      // clicking it early is a no-op and cascades into a doomed download search.
      const openLabels = ['Open in editor', 'Open in Editor', 'Edit', 'Customize', 'Open'];
      const openBtn = await waitFor(() => {
        for (const label of openLabels) {
          const b = findByText(label, true);
          if (b && isEnabled(b)) return b;
        }
        return null;
      }, 180_000);
      log(`Clicking "${openBtn.textContent.trim()}" (enabled)`);
      openBtn.click();

      // Python script waits 5s after Open in editor for the canvas to finish
      // loading before looking for the download control. Match that.
      await sleep(5000);
      await maybeCloseTour();

      // Diagnostic snapshot before download-icon search (shadow-DOM aware)
      const dlPresent     = deepQueryAll('x-icon[name="download"]').length;
      const anyDlIcons    = deepQueryAll('[class*="download" i], [aria-label*="download" i]').length;
      log(`Pre-download: url=${location.pathname.slice(0,40)} x-icon=${dlPresent} dl-ish=${anyDlIcons}`);

      // Download trigger — Adobe's actual button is a Spectrum
      // sp-action-button with aria-label="Download". The x-icon is just
      // a child; clicking the icon doesn't always reach the button's
      // click handler. Prefer the button itself; fall back to closest()
      // from the icon; final fallback is whatever has the aria-label.
      const dlButton = await waitFor(() => {
        const btn =
          deepQuery('sp-action-button[aria-label="Download"]') ||
          deepQuery('sp-icon-button[aria-label="Download"]')   ||
          deepQuery('[role="button"][aria-label="Download"]')  ||
          deepQuery('button[aria-label="Download"]')           ||
          deepQuery('[aria-label*="Download" i]:not(x-icon)')  ||
          null;
        if (btn) return btn;
        // Last resort: find the icon and walk up to its enclosing button
        const icon = deepQuery('x-icon[name="download"]');
        if (icon) {
          const wrapper = icon.closest('sp-action-button, sp-icon-button, button, [role="button"]');
          return wrapper || icon;
        }
        return null;
      }, 30_000);
      log(`Clicking download button (${dlButton.tagName.toLowerCase()}${dlButton.getAttribute('aria-label') ? ' "' + dlButton.getAttribute('aria-label') + '"' : ''})`);
      dlButton.click();
      await sleep(6000);

      await maybeCloseTour();

      // Final "Download" button in the panel. Adobe first shows a
      // "We are working on your downloads..." state where the panel
      // renders labels/headings containing the word "Download" but no
      // actionable CTA. Require an enabled, real button-like element,
      // and skip the opener we already clicked, so we naturally wait
      // out the preparing state instead of clicking a non-button.
      const finalBtn = await waitFor(() => {
        let last = null;
        for (const el of deepWalk()) {
          if (!isVisible(el)) continue;
          if (!isEnabled(el)) continue;
          if (inOurPanel(el)) continue;
          if (el === dlButton) continue;
          if (!el.matches || !el.matches(
            'button, sp-button, sp-action-button, sp-icon-button, [role="button"]'
          )) continue;
          const t = (el.textContent || '').trim();
          if (t === 'Download') last = el;
        }
        return last;
      }, 90_000);
      log(`Clicking final Download (${finalBtn.tagName.toLowerCase()})`);
      finalBtn.click();

      // Wait for download interception to fire
      const downloadStart = Date.now();
      while (Date.now() - downloadStart < DOWNLOAD_WAIT_MS) {
        if (GM_getValue(KEY_DOWNLOAD_DONE)) break;
        await sleep(500);
      }
      if (!GM_getValue(KEY_DOWNLOAD_DONE)) {
        log('Warning: download interception did not confirm save');
      }

      const duration = nowSec() - GM_getValue(KEY_STARTED_AT, nowSec());
      log(`Marking done (${duration.toFixed(1)}s)`);
      await markDone(acc.id, duration);

      // Clear per-account state BEFORE logout. adobeUiLogout navigates
      // the page (auth.services.adobe.com redirect), which kills this
      // JS context — the finally block below never runs on that path.
      // Without this, the next page load sees a stale KEY_ACCOUNT and
      // KEY_PHASE='editor', re-enters runEditorFlow, and markFailed's
      // update flips the just-done row to 'failed'.
      GM_setValue(KEY_ACCOUNT, null);
      GM_setValue(KEY_PHASE, 'login');

      // Sign out immediately after every successful download so the
      // next claim starts from a clean session. Non-fatal if it fails
      // — claimAndLaunch retries a logout before proceeding.
      log('Logging out after download');
      try { await adobeUiLogout(); } catch (e) { log(`Logout after download failed: ${e.message || e}`); }
    } catch (e) {
      const duration = nowSec() - GM_getValue(KEY_STARTED_AT, nowSec());
      log(`FAILED: ${e.message || e}`);
      try {
        await markFailed(acc.id, GM_getValue(KEY_PHASE, 'editor'), e.message || String(e), duration);
      } catch (e2) {
        log(`mark_failed also failed: ${e2.message || e2}`);
      }
    } finally {
      GM_setValue(KEY_ACCOUNT, null);
      GM_setValue(KEY_PHASE, 'login');
      refreshStats();
    }

    // Loop back: trigger next claim, which will navigate
    if (GM_getValue(KEY_RUNNING, false)) {
      driveLock = false;
      drive();
    }
    return true;
  }

  async function maybeCloseTour() {
    const skip = findByText('Skip tour', true);
    if (skip) { log('Skipping tour'); skip.click(); await sleep(500); return; }
    for (let i = 0; i < 5; i++) {
      const next = findByText('Next', true);
      if (!next) return;
      log('Tour: next');
      next.click();
      await sleep(700);
    }
  }

  // ===========================================================
  // Boot
  // ===========================================================
  function init() {
    if (document.getElementById('automator-panel')) return;
    injectStyle();
    setupDownloadHook();
    renderPanel();
    log(`Loaded on ${location.hostname}`);
    if (GM_getValue(KEY_RUNNING, false) && GM_getValue(KEY_SESSION)) drive();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
