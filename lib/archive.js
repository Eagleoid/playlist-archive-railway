'use strict';

const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');
const {
  loadArchived,
  setPlaylistName,
  markArchived,
  acquireLock,
  ensureDataDir,
} = require('./store');
const { listPlaylist, downloadVideo, workRoot, removeWorkDir, findDeno } = require('./ytdlp');
const {
  credentialsConfigured,
  playlistFolderId,
  findExistingUpload,
  uploadMp3,
  driveFileName,
} = require('./drive');

function applyTags(filePath, { title, artist, album }) {
  const tags = {};
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (!Object.keys(tags).length) return;
  const ok = NodeID3.update(tags, filePath);
  if (ok !== true) {
    throw new Error(`ID3 update failed for ${path.basename(filePath)}`);
  }
}

async function archiveNewTracks(playlist, { entries, title }) {
  const playlistName = playlist.name || title || playlist.listId;
  if (title && !playlist.name) setPlaylistName(playlist.listId, title);
  const archived = loadArchived();
  const fresh = entries.filter((entry) => !archived.videos[entry.id]);
  const result = {
    listId: playlist.listId,
    name: playlistName,
    url: playlist.url,
    liveCount: entries.length,
    alreadyArchived: entries.length - fresh.length,
    downloaded: [],
    skipped: [],
    errors: [],
    fatal: null,
  };
  if (!fresh.length) return result;
  if (!credentialsConfigured()) {
    result.fatal = 'Google Drive credentials are not configured';
    return result;
  }
  let folder;
  try {
    folder = await playlistFolderId(playlistName);
  } catch (err) {
    result.fatal = err.message;
    return result;
  }
  const preferMusic = /music\.youtube\.com/i.test(playlist.url);
  for (const entry of fresh) {
    const root = workRoot();
    const videoDir = path.join(root, entry.id);
    try {
      const existing = await findExistingUpload(folder.folderId, entry.id);
      if (existing) {
        markArchived({
          id: entry.id,
          title: entry.title,
          artist: entry.artist || '',
          playlistName,
          playlistUrl: playlist.url,
          listId: playlist.listId,
          filename: existing.name,
          bytes: Number(existing.size || 0),
          driveFileId: existing.id,
          driveFolderId: folder.folderId,
          archivedAt: new Date().toISOString(),
          source: 'drive-existing',
        });
        result.skipped.push({ id: entry.id, title: entry.title, reason: 'already in Drive', driveFileId: existing.id });
        continue;
      }
      const downloaded = await downloadVideo({
        videoId: entry.id,
        workRoot: root,
        preferMusic,
      });
      const artist = downloaded.artist || entry.artist || 'Unknown';
      const trackTitle = downloaded.title || entry.title || entry.id;
      try {
        applyTags(downloaded.filePath, { title: trackTitle, artist, album: playlistName });
      } catch (tagErr) {
        result.errors.push({ id: entry.id, title: trackTitle, error: `metadata: ${tagErr.message}` });
      }
      const filename = driveFileName({ title: trackTitle, artist, id: entry.id });
      const uploaded = await uploadMp3({
        folderId: folder.folderId,
        name: filename,
        filePath: downloaded.filePath,
      });
      const record = {
        id: entry.id,
        title: trackTitle,
        artist,
        album: playlistName,
        playlistName,
        playlistUrl: playlist.url,
        listId: playlist.listId,
        filename,
        bytes: downloaded.bytes,
        driveFileId: uploaded.id,
        driveFolderId: folder.folderId,
        webViewLink: uploaded.webViewLink || '',
        archivedAt: new Date().toISOString(),
        source: 'download',
      };
      markArchived(record);
      result.downloaded.push({
        id: entry.id,
        title: trackTitle,
        artist,
        bytes: downloaded.bytes,
        driveFileId: uploaded.id,
        filename,
      });
      removeWorkDir(videoDir);
    } catch (err) {
      result.errors.push({
        id: entry.id,
        title: entry.title,
        error: err.message,
      });
      removeWorkDir(videoDir);
    }
  }
  return result;
}

async function runCheck({ onlyListId = null } = {}) {
  ensureDataDir();
  const release = acquireLock();
  const startedAt = new Date().toISOString();
  try {
    const watch = loadWatchlist();
    const playlists = watch.playlists.filter((p) => !onlyListId || p.listId === onlyListId);
    const reports = [];
    for (const playlist of playlists) {
      try {
        const listed = await listPlaylist(playlist.url);
        reports.push(await archiveNewTracks(playlist, listed));
      } catch (err) {
        reports.push({
          listId: playlist.listId,
          name: playlist.name || playlist.listId,
          url: playlist.url,
          liveCount: 0,
          alreadyArchived: 0,
          downloaded: [],
          skipped: [],
          errors: [],
          fatal: err.message,
        });
      }
    }
    const finishedAt = new Date().toISOString();
    const summary = {
      ok: reports.every((r) => !r.fatal),
      startedAt,
      finishedAt,
      deno: Boolean(findDeno()),
      playlistCount: reports.length,
      newCount: reports.reduce((n, r) => n + r.downloaded.length, 0),
      errorCount: reports.reduce((n, r) => n + r.errors.length + (r.fatal ? 1 : 0), 0),
      playlists: reports,
    };
    try {
      const file = path.join(require('./config').dataDir(), 'last-check.json');
      fs.writeFileSync(file, JSON.stringify({
        ok: summary.ok,
        startedAt,
        finishedAt,
        playlistCount: summary.playlistCount,
        newCount: summary.newCount,
        errorCount: summary.errorCount,
      }, null, 2) + '\n');
    } catch (err) {
      console.error('failed to write last-check.json:', err.message);
    }
    return summary;
  } finally {
    release();
  }
}

module.exports = { runCheck, applyTags, archiveNewTracks };
