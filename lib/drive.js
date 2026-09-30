'use strict';

const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
const { archivesFolderName, driveRootId } = require('./config');

let authCache = null;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return undefined;
  }
  return null;
}

function credentialsConfigured() {
  return Boolean(
    (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim())
    || process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
}

function getAuth() {
  if (authCache) return authCache;
  const credentials = loadCredentials();
  if (credentials === null) {
    throw new Error('Google Drive credentials are not configured');
  }
  authCache = new GoogleAuth({
    credentials: credentials || undefined,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return authCache;
}

async function accessToken() {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('Google auth returned no access token');
  return token.token;
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveFetch(url, options = {}) {
  const token = await accessToken();
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, options.headers || {});
  const response = await fetch(url, Object.assign({}, options, { headers }));
  return response;
}

async function findChildFolder(parentId, name) {
  const q = [
    `name = '${escapeQuery(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    `'${escapeQuery(parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  const response = await driveFetch(url);
  if (!response.ok) {
    throw new Error(`Drive folder lookup failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  return body.files && body.files[0] ? body.files[0].id : null;
}

async function createFolder(parentId, name) {
  const url = 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name';
  const response = await driveFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  if (!response.ok) {
    throw new Error(`Drive folder create failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  return body.id;
}

async function findOrCreateFolder(parentId, name) {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing;
  return createFolder(parentId, name);
}

const folderCache = new Map();

async function playlistFolderId(playlistName) {
  const safeName = sanitizeDriveName(playlistName) || 'Untitled playlist';
  const cacheKey = `${driveRootId()}::${safeName}`;
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);
  const archivesId = await findOrCreateFolder(driveRootId(), archivesFolderName());
  const folderId = await findOrCreateFolder(archivesId, safeName);
  const result = { archivesId, folderId, name: safeName };
  folderCache.set(cacheKey, result);
  return result;
}

async function findExistingUpload(folderId, videoId) {
  const q = [
    `name contains '${escapeQuery(`[${videoId}]`)}'`,
    `'${escapeQuery(folderId)}' in parents`,
    'trashed = false',
    "mimeType != 'application/vnd.google-apps.folder'",
  ].join(' and ');
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name,size)');
  url.searchParams.set('pageSize', '5');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  const response = await driveFetch(url);
  if (!response.ok) {
    throw new Error(`Drive file lookup failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  return body.files && body.files[0] ? body.files[0] : null;
}

async function uploadMp3({ folderId, name, filePath }) {
  const size = fs.statSync(filePath).size;
  const startUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,size';
  const start = await driveFetch(startUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'audio/mpeg',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({
      name,
      parents: [folderId],
      mimeType: 'audio/mpeg',
    }),
  });
  if (!start.ok) {
    throw new Error(`Drive upload init failed (${start.status}): ${await start.text()}`);
  }
  const location = start.headers.get('location');
  if (!location) throw new Error('Drive upload init returned no Location header');
  const bytes = fs.readFileSync(filePath);
  const put = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`Drive upload failed (${put.status}): ${await put.text()}`);
  }
  return put.json();
}

function sanitizeDriveName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function driveFileName({ title, artist, id }) {
  const t = sanitizeDriveName(title) || id;
  const a = sanitizeDriveName(artist);
  const base = a ? `${t} - ${a}` : t;
  return `${base} [${id}].mp3`;
}

module.exports = {
  credentialsConfigured,
  playlistFolderId,
  findExistingUpload,
  uploadMp3,
  sanitizeDriveName,
  driveFileName,
};
