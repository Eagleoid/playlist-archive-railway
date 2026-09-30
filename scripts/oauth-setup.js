'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const REDIRECT_URI = 'http://127.0.0.1:8765/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const OUTPUT_PATH = '/workspace/secrets/google-oauth-refresh.json';

function argumentValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function clientCredentials() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    return !args[index - 1] || !args[index - 1].startsWith('--');
  });
  const clientId = String(
    argumentValue(args, '--client-id')
      || process.env.GOOGLE_OAUTH_CLIENT_ID
      || process.env.CLIENT_ID
      || positional[0]
      || '',
  ).trim();
  const clientSecret = String(
    argumentValue(args, '--client-secret')
      || process.env.GOOGLE_OAUTH_CLIENT_SECRET
      || process.env.CLIENT_SECRET
      || positional[1]
      || '',
  ).trim();
  return { clientId, clientSecret };
}

function openUrl(url) {
  try {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printing the URL below is sufficient when no desktop opener is available.
  }
}

async function run() {
  const { clientId, clientSecret } = clientCredentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Provide the OAuth client ID and secret via GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET '
      + 'or --client-id/--client-secret.',
    );
  }

  const oauth = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:8765');
    if (requestUrl.pathname !== '/oauth2callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    if (error || !code) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Authorization failed${error ? `: ${error}` : ''}`);
      process.exitCode = 1;
      server.close();
      return;
    }

    try {
      const { tokens } = await oauth.getToken(code);
      if (!tokens || !tokens.refresh_token) {
        throw new Error('Google did not return a refresh token; try again with prompt=consent');
      }
      fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
      }, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(OUTPUT_PATH, 0o600);
      console.log(`refresh_token=${tokens.refresh_token}`);
      console.log(`Saved OAuth credentials to ${OUTPUT_PATH}`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Authorization complete. You can close this window.\n');
      server.close(() => process.exit(0));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Authorization failed: ${err.message}\n`);
      console.error(err.message || err);
      process.exitCode = 1;
      server.close();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, '127.0.0.1', resolve);
  });

  console.log(`Open this Google authorization URL:\n${authUrl}`);
  openUrl(authUrl);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
