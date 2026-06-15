// ==UserScript==
// @name         Adobe Express Automator
// @namespace    https://github.com/YOUR_HANDLE/YOUR_REPO
// @version      0.1.0
// @description  Distributed Adobe Express image generation worker
// @author       you
// @match        https://new.express.adobe.com/*
// @match        https://express.adobe.com/*
// @match        https://login.microsoftonline.com/*
// @match        https://auth.services.adobe.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/YOUR_HANDLE/YOUR_REPO/main/automator.user.js
// @downloadURL  https://raw.githubusercontent.com/YOUR_HANDLE/YOUR_REPO/main/automator.user.js
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
  const DOWNLOAD_WAIT_MS     = 30_000;

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

  function sanitizeFilename(email) {
    return email.replace('@', '_').replace(/[\/\\?%*:|"<>]/g, '_');
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
    return !!el.offsetParent;
  }

  function findByText(text, exact = true, tags = ['button', 'a', 'span', 'div', 'p']) {
    for (const tag of tags) {
      for (const el of document.querySelectorAll(tag)) {
        const t = (el.textContent || '').trim();
        if ((exact ? t === text : t.includes(text)) && isVisible(el)) return el;
      }
    }
    return null;
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

  function gmCookie(action, payload) {
    return new Promise((resolve, reject) => {
      GM_cookie(action, payload, (result, err) => {
        if (err) reject(err); else resolve(result);
      });
    });
  }

  async function wipeSessionCookies() {
    const domains = ['adobe.com', 'microsoftonline.com', 'microsoft.com', 'live.com', 'office.com'];
    try {
      const cookies = await gmCookie('list', {});
      let wiped = 0;
      for (const c of cookies || []) {
        if (domains.some(d => c.domain.includes(d))) {
          await gmCookie('delete', {
            name: c.name,
            url:  `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`
          });
          wiped++;
        }
      }
      log(`Cookie wipe: ${wiped}`);
    } catch (e) {
      log(`Cookie wipe failed: ${e.message || e}`);
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
  // Download interception — rename to <email_domain>.png
  // ===========================================================
  function setupDownloadHook() {
    const handler = (e) => {
      const acc = GM_getValue(KEY_ACCOUNT);
      if (!acc) return;
      const a = e.target.closest && e.target.closest('a[download], a[href*=".png"], a[href*=".jpg"], a[href*=".jpeg"]');
      if (!a || !a.href || a.href.startsWith('javascript:')) return;

      const filename = `${sanitizeFilename(acc.email)}.png`;
      log(`Intercepting download → ${filename}`);
      e.preventDefault();
      e.stopImmediatePropagation();
      GM_download({
        url:  a.href,
        name: filename,
        saveAs: false,
        onload:  () => { log('Download saved'); GM_setValue(KEY_DOWNLOAD_DONE, true); },
        onerror: (err) => log(`GM_download err: ${err && (err.error || err.details) || err}`)
      });
    };
    document.addEventListener('click', handler, true);
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
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        background: #111; color: #eee; font: 12px/1.4 system-ui, sans-serif;
        border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        min-width: 280px; max-width: 320px; padding: 12px;
      }
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
      await wipeSessionCookies();
      location.href = 'https://new.express.adobe.com/';
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

  async function handleMicrosoftLogin() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;
    log('On Microsoft login');
    for (let i = 0; i < MAX_LOGIN_ITERATIONS; i++) {
      if (!GM_getValue(KEY_RUNNING, false)) return false;

      const emailInput = document.querySelector('input[type="email"]');
      if (emailInput && isVisible(emailInput) && !emailInput.value) {
        log('Filling email');
        fillInput(emailInput, acc.email);
        await sleep(200);
        const next = findByText('Next', true) || document.querySelector('input[type="submit"]');
        if (next) next.click(); else pressEnter(emailInput);
        await sleep(2500);
        continue;
      }

      const pwInput = document.querySelector('input[type="password"]');
      if (pwInput && isVisible(pwInput) && !pwInput.value) {
        log('Filling password');
        fillInput(pwInput, acc.password);
        await sleep(200);
        const signin = findByText('Sign in', true) || document.querySelector('input[type="submit"]');
        if (signin) signin.click(); else pressEnter(pwInput);
        await sleep(2500);
        continue;
      }

      const no = document.querySelector('input[value="No"]');
      if (no && isVisible(no)) {
        log('Clicking No on "Stay signed in"');
        no.click();
        await sleep(2500);
        continue;
      }

      await sleep(500);
    }
    return true;
  }

  async function handleAdobeAuth() {
    log('On Adobe auth — letting it redirect');
    await sleep(5000);
    return true;
  }

  async function handleExpress() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;

    // If still on a login-ish path, wait briefly for redirect to settle
    await sleep(1500);

    // If we landed on the bare express homepage and haven't gone to TARGET yet,
    // navigate to the generation URL.
    const phase = GM_getValue(KEY_PHASE, 'login');
    if (phase !== 'editor' && !location.search.includes('prompt=')) {
      log('Express loaded — navigating to target prompt');
      GM_setValue(KEY_PHASE, 'editor');
      location.href = TARGET_URL;
      return false;
    }

    return await runEditorFlow();
  }

  async function runEditorFlow() {
    const acc = GM_getValue(KEY_ACCOUNT);
    if (!acc) return false;
    try {
      // Open in editor
      try {
        const openBtn = await waitFor(() => findByText('Open in editor', true), 30_000);
        log('Clicking Open in editor');
        openBtn.click();
      } catch {
        log('No "Open in editor" — maybe already in editor');
      }

      await sleep(3000);
      await maybeCloseTour();

      // Download icon
      const dlIcon = await waitFor(
        () => document.querySelector('x-icon[name="download"]'),
        30_000
      );
      log('Clicking download icon');
      dlIcon.click();
      await sleep(3000);

      await maybeCloseTour();

      // Final Download button — Adobe shows this in a dropdown/modal
      const finalBtn = await waitFor(() => {
        const all = Array.from(document.querySelectorAll('button, span, div'))
          .filter(el => (el.textContent || '').trim() === 'Download' && isVisible(el));
        return all[all.length - 1] || null;
      }, 15_000);
      log('Clicking final Download');
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
