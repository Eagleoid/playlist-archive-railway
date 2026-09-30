'use strict';

const path = require('path');

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

function port() {
  const n = Number(process.env.PORT || 8080);
  return Number.isFinite(n) && n > 0 ? n : 8080;
}

function isCronMode(argv = process.argv) {
  return process.env.CRON_MODE === '1' || argv.includes('--cron');
}

function tz() {
  return process.env.TZ || 'America/New_York';
}

function dailyCheckTime() {
  const raw = process.env.DAILY_CHECK_TIME;
  if (raw === undefined) return '08:22';
  return String(raw).trim();
}

function apiToken() {
  const token = process.env.API_TOKEN;
  return token ? String(token).trim() : '';
}

function ytdlpBin() {
  return process.env.YTDLP_BIN || 'yt-dlp';
}

function archivesFolderName() {
  if (process.env.ARCHIVES_FOLDER_NAME !== undefined) {
    return String(process.env.ARCHIVES_FOLDER_NAME).trim();
  }
  return 'YouTube Playlist Archives';
}

function driveRootId() {
  const id = (process.env.DRIVE_ROOT_FOLDER_ID || '').trim();
  return id || 'root';
}

module.exports = {
  dataDir,
  port,
  isCronMode,
  tz,
  dailyCheckTime,
  apiToken,
  ytdlpBin,
  archivesFolderName,
  driveRootId,
  path,
};
