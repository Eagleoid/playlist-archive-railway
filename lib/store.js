'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./config');

function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function watchlistPath() {
  return path.join(dataDir(), 'watchlist.json');
}

function archivedPath() {
  return path.join(dataDir(), 'archived.json');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

function writeJson(file, data) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function loadWatchlist() {
  const data = readJson(watchlistPath(), { playlists: [] });
  if (!data || !Array.isArray(data.playlists)) {
    throw new Error('watchlist.json is missing a playlists array');
  }
  return data;
}

function saveWatchlist(data) {
  writeJson(watchlistPath(), data);
}

function loadArchived() {
  const data = readJson(archivedPath(), { videos: {} });
  if (!data || typeof data.videos !== 'object' || Array.isArray(data.videos)) {
    throw new Error('archived.json is missing a videos object');
  }
  return data;
}

function saveArchived(data) {
  writeJson(archivedPath(), data);
}

function playlistIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const allowed = new Set([
    'youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
  ]);
  if (!allowed.has(host)) return null;
  const list = parsed.searchParams.get('list');
  if (!list) return null;
  if (!/^[\w-]{10,}$/.test(list)) return null;
  return list;
}

function assertPlaylistUrl(url) {
  if (!url || typeof url !== 'string') {
    throw Object.assign(new Error('url is required'), { status: 400 });
  }
  const id = playlistIdFromUrl(url.trim());
  if (!id) {
    throw Object.assign(
      new Error('url must be a YouTube or YouTube Music playlist URL with a list id'),
      { status: 400 },
    );
  }
  return { url: url.trim(), listId: id };
}

/**
 * Add or update a playlist. Dedupes on the list id.
 * Returns { created, playlist }.
 */
function upsertPlaylist({ url, name }) {
  const parsed = assertPlaylistUrl(url);
  const data = loadWatchlist();
  const now = new Date().toISOString();
  const existing = data.playlists.find((p) => p.listId === parsed.listId);
  if (existing) {
    if (name && String(name).trim()) existing.name = String(name).trim();
    existing.url = parsed.url;
    existing.updatedAt = now;
    saveWatchlist(data);
    return { created: false, playlist: existing };
  }
  const playlist = {
    id: crypto.randomUUID(),
    listId: parsed.listId,
    url: parsed.url,
    name: name && String(name).trim() ? String(name).trim() : '',
    addedAt: now,
    updatedAt: now,
  };
  data.playlists.push(playlist);
  saveWatchlist(data);
  return { created: true, playlist };
}

function setPlaylistName(listId, name) {
  if (!name) return;
  const data = loadWatchlist();
  const row = data.playlists.find((p) => p.listId === listId);
  if (!row) return;
  if (!row.name) {
    row.name = name;
    row.updatedAt = new Date().toISOString();
    saveWatchlist(data);
  }
}

function isArchived(videoId) {
  const data = loadArchived();
  return Boolean(data.videos[videoId]);
}

function markArchived(video) {
  const data = loadArchived();
  data.videos[video.id] = video;
  saveArchived(data);
}

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function lockPath() {
  return path.join(dataDir(), 'check.lock');
}

function acquireLock() {
  ensureDataDir();
  const file = lockPath();
  const write = () => {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
  };
  try {
    write();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let stale = false;
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      stale = age > LOCK_STALE_MS;
    } catch (statErr) {
      if (statErr.code !== 'ENOENT') throw statErr;
      stale = true;
    }
    if (!stale) {
      throw Object.assign(new Error('check already running'), { status: 409 });
    }
    fs.rmSync(file, { force: true });
    write();
  }
  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  };
}

module.exports = {
  ensureDataDir,
  loadWatchlist,
  saveWatchlist,
  loadArchived,
  saveArchived,
  playlistIdFromUrl,
  assertPlaylistUrl,
  upsertPlaylist,
  setPlaylistName,
  isArchived,
  markArchived,
  acquireLock,
};
