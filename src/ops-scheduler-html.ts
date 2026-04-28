/**
 * Single-page shell for /ops/scheduler: Firebase Auth (Google) + fetch with Bearer ID token.
 * Cross-ref: src/ops-routes.ts, src/firebase-ops-auth.ts
 */

export type OpsSchedulerShellConfig = {
  firebaseWebApiKey: string;
  firebaseAuthDomain: string;
  firebaseProjectId: string;
  schedulerJobName: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML document that loads Firebase compat SDK from Google CDN and drives pause/resume via JSON APIs. */
export function renderOpsSchedulerShell(cfg: OpsSchedulerShellConfig): string {
  const firebaseJson = JSON.stringify({
    apiKey: cfg.firebaseWebApiKey,
    authDomain: cfg.firebaseAuthDomain,
    projectId: cfg.firebaseProjectId,
  });
  const jobNameEscaped = escapeHtml(cfg.schedulerJobName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto dry (check-humidity schedule)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 1rem auto; padding: 0 0.5rem; }
    code { background: #eee; padding: 0.1em 0.3em; border-radius: 3px; }
    .ok { color: #0a0; } .err { color: #a00; } .muted { color: #555; }
    button { padding: 0.4rem 0.8rem; cursor: pointer; margin-right: 0.5rem; margin-top: 0.25rem; }
    #signInBtn { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Auto dry (humidity schedule)</h1>
  <p class="muted">Controls Cloud Scheduler job <code>${jobNameEscaped}</code> only — nightly <code>daikin-dry-stop-safety</code> is unchanged.</p>

  <div id="signedOut">
    <p><button type="button" id="signInBtn">Sign in with Google</button></p>
    <p class="muted">After signing in, you can pause or resume the humidity check schedule.</p>
  </div>

  <div id="signedIn" style="display:none">
    <p>Signed in as <strong id="who"></strong>.</p>
    <p>Current Scheduler state: <strong id="stateLabel">…</strong></p>
    <p id="banner"></p>
    <p>
      <button type="button" id="pauseBtn">Disable auto dry (pause check-humidity)</button>
      <button type="button" id="resumeBtn">Enable auto dry (resume check-humidity)</button>
    </p>
  </div>

  <script>
  window.__FIREBASE_CFG__ = ${firebaseJson};
  </script>
  <script>
  (function () {
    var firebaseCfg = window.__FIREBASE_CFG__;
    function loadScript(src, onload) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = onload;
      s.onerror = function () {
        document.body.innerHTML = '<p class="err">Failed to load Firebase SDK. Check network / CSP.</p>';
      };
      document.head.appendChild(s);
    }
    function $(id) { return document.getElementById(id); }
    function showErr(msg) {
      var b = $('banner');
      if (b) { b.className = 'err'; b.textContent = msg; }
    }
    function showOk(msg) {
      var b = $('banner');
      if (b) { b.className = 'ok'; b.textContent = msg; }
    }
    async function bearerHeaders() {
      if (!firebase || !firebase.auth) return {};
      var u = firebase.auth().currentUser;
      if (!u) return {};
      var token = await u.getIdToken();
      return { Authorization: 'Bearer ' + token };
    }
    async function refreshState() {
      var h = await bearerHeaders();
      if (!h.Authorization) return;
      var res = await fetch('/ops/scheduler/state', { headers: h });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        showErr(data.message || ('HTTP ' + res.status));
        return;
      }
      $('stateLabel').textContent = data.stateLabel || 'unknown';
      $('who').textContent = data.email || '';
      showOk('');
    }
    async function postAction(action) {
      var h = await bearerHeaders();
      if (!h.Authorization) {
        showErr('Not signed in.');
        return;
      }
      var res = await fetch('/ops/scheduler', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, h),
        body: JSON.stringify({ action: action }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        showErr(data.message || ('HTTP ' + res.status));
        return;
      }
      showOk(data.message || 'Updated.');
      $('stateLabel').textContent = data.stateLabel || 'unknown';
    }
    function wireUi() {
      $('signInBtn').onclick = function () {
        if (!firebase.auth) return;
        var provider = new firebase.auth.GoogleAuthProvider();
        firebase.auth().signInWithPopup(provider).catch(function (e) {
          showErr(e.message || String(e));
        });
      };
      $('pauseBtn').onclick = function () { postAction('pause'); };
      $('resumeBtn').onclick = function () { postAction('resume'); };
      firebase.auth().onAuthStateChanged(function (user) {
        if (user) {
          $('signedOut').style.display = 'none';
          $('signedIn').style.display = 'block';
          refreshState();
        } else {
          $('signedIn').style.display = 'none';
          $('signedOut').style.display = 'block';
        }
      });
    }
    loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js', function () {
      loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js', function () {
        try {
          firebase.initializeApp(firebaseCfg);
        } catch (e) {
          document.body.innerHTML = '<p class="err">Firebase init failed: ' + String(e) + '</p>';
          return;
        }
        wireUi();
      });
    });
  })();
  </script>
</body>
</html>`;
}

/** Minimal error page when FIREBASE_WEB_API_KEY is missing in production. */
export function renderOpsSchedulerMisconfigured(message: string): string {
  const m = escapeHtml(message);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>/ops misconfigured</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 0.5rem;">
<p style="color:#a00"><strong>Configuration error</strong></p><p>${m}</p></body></html>`;
}
