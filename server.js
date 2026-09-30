'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { port, isCronMode, dataDir, apiToken } = require('./lib/config');
const { ensureDataDir, loadWatchlist, upsertPlaylist, playlistIdFromUrl } = require('./lib/store');
const { runCheck } = require('./lib/archive');
const { downloadVideo, probeAudio, findDeno, workRoot, removeWorkDir } = require('./lib/ytdlp');
const { credentialsConfigured } = require('./lib/drive');
const { isDue, markRan, normalizeTime } = require('./lib/schedule');

function videoIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id && /^[\w-]{6,}$/.test(id) ? id : null;
  }
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
  const v = parsed.searchParams.get('v');
  if (v && /^[\w-]{6,}$/.test(v)) return v;
  const shorts = parsed.pathname.match(/^\/shorts\/([\w-]{6,})/);
  if (shorts) return shorts[1];
  return null;
}

function bearerOk(req) {
  const expected = apiToken();
  if (!expected) return false;
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  if (presented.length !== want.length) return false;
  return crypto.timingSafeEqual(presented, want);
}

function requireToken(req, res, next) {
  if (!apiToken()) {
    res.status(503).json({ ok: false, error: 'API_TOKEN is not set' });
    return;
  }
  if (!bearerOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  next();
}

function readLastCheck() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'last-check.json'), 'utf8'));
  } catch {
    return null;
  }
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      deno: Boolean(findDeno()),
      driveConfigured: credentialsConfigured(),
      tokenConfigured: Boolean(apiToken()),
      dataDir: dataDir(),
      dailyCheckTime: normalizeTime(process.env.DAILY_CHECK_TIME === undefined ? '08:22' : process.env.DAILY_CHECK_TIME),
      lastCheck: readLastCheck(),
    });
  });

  app.get('/watchlist', requireToken, (_req, res) => {
    try {
      res.json({ ok: true, ...loadWatchlist() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/watchlist', requireToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.url || typeof body.url !== 'string') {
        res.status(400).json({ ok: false, error: 'url is required' });
        return;
      }
      const saved = upsertPlaylist({ url: body.url, name: body.name });
      const archive = body.archive === true;
      if (!archive) {
        res.status(saved.created ? 201 : 200).json({
          ok: true,
          created: saved.created,
          playlist: saved.playlist,
        });
        return;
      }
      const summary = await runCheck({ onlyListId: saved.playlist.listId });
      res.status(summary.ok ? 200 : 500).json({
        ok: summary.ok,
        created: saved.created,
        playlist: loadWatchlist().playlists.find((p) => p.listId === saved.playlist.listId) || saved.playlist,
        archive: summary,
      });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  });

  app.post('/check', requireToken, async (_req, res) => {
    try {
      const summary = await runCheck();
      res.status(summary.ok ? 200 : 500).json(summary);
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  });

  app.post('/test-download', requireToken, async (req, res) => {
    const body = req.body || {};
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      res.status(400).json({ ok: false, error: 'url is required' });
      return;
    }
    let videoId = videoIdFromUrl(url);
    const preferMusic = /music\.youtube\.com/i.test(url);
    try {
      if (!videoId) {
        if (!playlistIdFromUrl(url)) {
          res.status(400).json({ ok: false, error: 'url must be a YouTube video or playlist URL' });
          return;
        }
        const { listPlaylist } = require('./lib/ytdlp');
        const listed = await listPlaylist(url);
        if (!listed.entries.length) {
          res.status(404).json({ ok: false, error: 'playlist has no videos' });
          return;
        }
        videoId = listed.entries[0].id;
      }
      const root = workRoot();
      const downloaded = await downloadVideo({ videoId, workRoot: root, preferMusic });
      const probe = await probeAudio(downloaded.filePath);
      const stream = probe && probe.streams && probe.streams[0] ? probe.streams[0] : {};
      const format = probe && probe.format ? probe.format : {};
      res.json({
        ok: true,
        id: downloaded.id,
        title: downloaded.title,
        artist: downloaded.artist,
        path: downloaded.filePath,
        bytes: downloaded.bytes,
        codec: stream.codec_name || null,
        sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
        channels: stream.channels || null,
        duration: format.duration ? Number(format.duration) : null,
        format: format.format_name || null,
        drive: false,
      });
    } catch (err) {
      if (videoId) removeWorkDir(path.join(workRoot(), videoId));
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'invalid JSON' });
      return;
    }
    res.status(500).json({ ok: false, error: err.message || 'internal error' });
  });

  return app;
}

function startScheduler() {
  const tick = async () => {
    const due = isDue();
    if (!due.due) return;
    console.log(JSON.stringify({ event: 'scheduled-check', day: due.day, scheduled: due.scheduled }));
    try {
      const summary = await runCheck();
      markRan(due.day);
      console.log(JSON.stringify({
        event: 'scheduled-check-done',
        ok: summary.ok,
        newCount: summary.newCount,
        errorCount: summary.errorCount,
      }));
    } catch (err) {
      if (err.status === 409) return;
      console.error(JSON.stringify({ event: 'scheduled-check-failed', error: err.message }));
    }
  };
  setInterval(() => {
    tick().catch((err) => console.error(err));
  }, 30 * 1000);
  setTimeout(() => {
    tick().catch((err) => console.error(err));
  }, 5000);
}

async function main() {
  ensureDataDir();
  if (isCronMode()) {
    try {
      const summary = await runCheck();
      console.log(JSON.stringify(summary));
      process.exit(summary.ok ? 0 : 1);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
    return;
  }
  const app = createApp();
  const listenPort = port();
  app.listen(listenPort, '0.0.0.0', () => {
    console.log(JSON.stringify({
      event: 'listen',
      port: listenPort,
      dataDir: dataDir(),
      deno: Boolean(findDeno()),
    }));
  });
  startScheduler();
}

if (require.main === module) {
  main();
}

module.exports = { createApp, videoIdFromUrl, bearerOk };
