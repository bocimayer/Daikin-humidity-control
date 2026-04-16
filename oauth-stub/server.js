/**
 * Minimal Cloud Run stub: same surface we rely on for Daikin OAuth (public HTTPS).
 *
 * Cross-references:
 *   - Main app routes: ../src/routes.ts (GET /health)
 *   - OAuth onboarding: ../README.md (authorization code flow)
 *   - Deploy: ../.github/workflows/deploy-oauth-stub.yml, ../setup/deploy-oauth-stub.sh
 */

'use strict';

const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);

/**
 * HTML shown after Daikin redirects here with ?code=… or ?error=…
 * (register this full URL in the Daikin developer portal as redirect_uri).
 */
function oauthCallbackPage(search, absoluteUrl) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OAuth redirect (stub)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
    pre { background: #f4f4f5; padding: 1rem; overflow-x: auto; border-radius: 6px; }
    input.full-url { width: 100%; font-size: 0.85rem; padding: 0.5rem; box-sizing: border-box; }
    h1 { font-size: 1.25rem; }
  </style>
</head>
<body>
  <h1>Daikin OAuth redirect (stub)</h1>
  <p>Copy the <strong>code</strong> from below (or the full URL) for the token exchange.</p>
  <label for="u">Full redirect URL</label>
  <p><input id="u" class="full-url" readonly value="${esc(absoluteUrl)}"/></p>
  <h2>Query parameters</h2>
  <pre>${esc(search || '(none)')}</pre>
  <p><small>This service is a stand-in until the main humidity app owns the same path.</small></p>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || 'localhost';
  const fullUrl = new URL(req.url || '/', `http://${host}`);

  console.log(
    JSON.stringify({
      msg: 'request',
      method: req.method,
      path: fullUrl.pathname,
      hasQuery: fullUrl.search.length > 1,
    }),
  );

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (fullUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'daikin-oauth-stub', ts: new Date().toISOString() }));
    return;
  }

  if (fullUrl.pathname === '/oauth/callback') {
    const absoluteUrl = `https://${host}${fullUrl.pathname}${fullUrl.search}`;
    const body = oauthCallbackPage(
      fullUrl.search.replace(/^\?/, '') || '',
      absoluteUrl,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'listening', port: PORT }));
});
