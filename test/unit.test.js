'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'playlist-archive-test-'));
process.env.API_TOKEN = 'test-token';
process.env.DAILY_CHECK_TIME = '';
process.env.TZ = 'America/New_York';
delete process.env.CRON_MODE;
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const { splitArgs } = require('../lib/args');
const { playlistIdFromUrl, upsertPlaylist, loadArchived, markArchived, acquireLock } = require('../lib/store');
const { isCronMode } = require('../lib/config');
const { normalizeTime, isDue, markRan, zonedParts } = require('../lib/schedule');
const { driveFileName, sanitizeDriveName } = require('../lib/drive');
const { createApp, videoIdFromUrl } = require('../server');

test('splitArgs respects quotes', () => {
  assert.deepEqual(splitArgs('--cookies "/data/my cookies.txt" --no-warnings'), [
    '--cookies',
    '/data/my cookies.txt',
    '--no-warnings',
  ]);
  assert.deepEqual(splitArgs(''), []);
  assert.throws(() => splitArgs('--cookies "unterminated'));
});

test('playlist and video urls', () => {
  assert.equal(
    playlistIdFromUrl('https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrst'),
    'PLabcdefghijklmnopqrst',
  );
  assert.equal(
    playlistIdFromUrl('https://music.youtube.com/playlist?list=PLabcdefghijklmnopqrst'),
    'PLabcdefghijklmnopqrst',
  );
  assert.equal(playlistIdFromUrl('https://example.com/playlist?list=PLabcdefghijklmnopqrst'), null);
  assert.equal(playlistIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('watchlist dedupes on list id and archive store records ids', () => {
  const url = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrst';
  const first = upsertPlaylist({ url, name: 'Morning' });
  assert.equal(first.created, true);
  assert.equal(first.playlist.name, 'Morning');
  const second = upsertPlaylist({ url: 'https://music.youtube.com/playlist?list=PLabcdefghijklmnopqrst' });
  assert.equal(second.created, false);
  assert.equal(second.playlist.id, first.playlist.id);
  assert.equal(second.playlist.url.includes('music.youtube.com'), true);
  markArchived({ id: 'abcdefghijk', title: 'Song', artist: 'A', archivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(Boolean(loadArchived().videos.abcdefghijk), true);
});

test('lock rejects a second holder and cron flag', () => {
  const release = acquireLock();
  assert.throws(() => acquireLock(), (err) => err.status === 409);
  release();
  const release2 = acquireLock();
  release2();
  assert.equal(isCronMode(['node', 'server.js', '--cron']), true);
  assert.equal(isCronMode(['node', 'server.js']), false);
});

test('scheduler is disabled when DAILY_CHECK_TIME is empty', () => {
  assert.equal(normalizeTime(''), null);
  assert.equal(normalizeTime('08:22'), '08:22');
  assert.equal(normalizeTime('8:22'), '08:22');
  assert.equal(normalizeTime('25:00'), null);
  assert.equal(isDue().due, false);
  process.env.DAILY_CHECK_TIME = '00:00';
  const parts = zonedParts(new Date());
  markRan('1999-01-01');
  const due = isDue(new Date());
  assert.equal(due.due, true);
  markRan(parts.day);
  assert.equal(isDue(new Date()).due, false);
  process.env.DAILY_CHECK_TIME = '';
});

test('drive file names keep the video id and drop slashes', () => {
  assert.equal(sanitizeDriveName('a/b\\c'), 'a - b - c');
  assert.equal(
    driveFileName({ title: 'Song', artist: 'Artist', id: 'abcdefghijk' }),
    'Song - Artist [abcdefghijk].mp3',
  );
});

function request(port, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: Object.assign(
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        token ? { authorization: `Bearer ${token}` } : {},
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('API auth and watchlist add', async () => {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const denied = await request(port, 'GET', '/watchlist');
    assert.equal(denied.status, 401);
    const added = await request(port, 'POST', '/watchlist', {
      token: 'test-token',
      body: { url: 'https://www.youtube.com/playlist?list=PLzzzzzzzzzzzzzzzzzzzz', name: 'Zed' },
    });
    assert.equal(added.status, 201);
    assert.equal(added.json.playlist.name, 'Zed');
    const missing = await request(port, 'GET', '/nope', { token: 'test-token' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
