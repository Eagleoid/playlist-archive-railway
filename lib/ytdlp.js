'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ytdlpBin } = require('./config');
const { extraArgs } = require('./args');

function findDeno() {
  const candidates = [
    process.env.DENO_BIN,
    '/usr/local/bin/deno',
    '/usr/bin/deno',
    '/workspace/.deno/bin/deno',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function runtimeArgs() {
  const deno = findDeno();
  if (!deno) return [];
  return ['--js-runtimes', `deno:${deno}`];
}

function runProcess(bin, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const error = new Error(`${bin} exited ${code}: ${err.trim().slice(-2000) || out.trim().slice(-500)}`);
        error.code = code;
        error.stderr = err;
        error.stdout = out;
        reject(error);
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

function baseArgs() {
  return [...runtimeArgs(), ...extraArgs()];
}

async function listPlaylist(url) {
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--ignore-errors',
    ...baseArgs(),
    url,
  ];
  const { stdout } = await runProcess(ytdlpBin(), args, { timeoutMs: 10 * 60 * 1000 });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp did not return playlist JSON');
  }
  const entries = [];
  const seen = new Set();
  for (const entry of info.entries || []) {
    if (!entry || !entry.id || entry.id === 'NA') continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push({
      id: entry.id,
      title: entry.title && entry.title !== 'NA' ? entry.title : entry.id,
      artist: pickArtist(entry),
    });
  }
  const title = info.title && info.title !== 'NA' ? info.title : '';
  return { title, entries, id: info.id || null };
}

function pickArtist(info) {
  if (!info) return '';
  if (typeof info.artist === 'string' && info.artist && info.artist !== 'NA') return info.artist;
  if (Array.isArray(info.artists) && info.artists.length) {
    const names = info.artists
      .map((a) => (typeof a === 'string' ? a : a && (a.name || a.artist)))
      .filter(Boolean);
    if (names.length) return names.join(', ');
  }
  for (const key of ['creator', 'uploader', 'channel', 'album_artist']) {
    if (typeof info[key] === 'string' && info[key] && info[key] !== 'NA') return info[key];
  }
  return '';
}

function watchUrl(videoId, preferMusic) {
  const host = preferMusic ? 'music.youtube.com' : 'www.youtube.com';
  return `https://${host}/watch?v=${encodeURIComponent(videoId)}`;
}

async function downloadVideo({ videoId, workRoot, preferMusic = false }) {
  const outDir = path.join(workRoot, videoId);
  fs.mkdirSync(outDir, { recursive: true });
  const template = path.join(outDir, '%(id)s.%(ext)s');
  const url = watchUrl(videoId, preferMusic);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--embed-metadata',
    '--convert-thumbnails', 'jpg',
    '--write-info-json',
    '-o', template,
    ...baseArgs(),
    url,
  ];
  try {
    await runProcess(ytdlpBin(), args, { timeoutMs: 20 * 60 * 1000 });
  } catch (err) {
    if (!preferMusic && /unavailable|not available|private video|sign in/i.test(err.stderr || err.message || '')) {
      fs.rmSync(outDir, { recursive: true, force: true });
      return downloadVideo({ videoId, workRoot, preferMusic: true });
    }
    throw err;
  }
  const mp3 = fs.readdirSync(outDir).find((name) => name.toLowerCase().endsWith('.mp3'));
  if (!mp3) throw new Error(`yt-dlp produced no mp3 for ${videoId}`);
  const filePath = path.join(outDir, mp3);
  let info = {};
  const infoPath = path.join(outDir, `${videoId}.info.json`);
  if (fs.existsSync(infoPath)) {
    try {
      info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch {
      info = {};
    }
  }
  const stat = fs.statSync(filePath);
  return {
    id: videoId,
    filePath,
    infoPath: fs.existsSync(infoPath) ? infoPath : null,
    title: info.title && info.title !== 'NA' ? info.title : videoId,
    artist: pickArtist(info),
    bytes: stat.size,
    info,
  };
}

function probeAudio(filePath) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,codec_type,bit_rate,sample_rate,channels',
      '-show_entries', 'format=duration,size,format_name',
      '-of', 'json',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

function workRoot() {
  const root = path.join(os.tmpdir(), 'playlist-archive');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function removeWorkDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  findDeno,
  runtimeArgs,
  listPlaylist,
  downloadVideo,
  probeAudio,
  pickArtist,
  workRoot,
  removeWorkDir,
  watchUrl,
};
