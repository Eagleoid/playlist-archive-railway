# Playlist archive (Railway)

Watches YouTube and YouTube Music playlists, downloads new tracks as highest-quality MP3s (artist, title, album, and thumbnail embedded), and uploads them to Google Drive at:

`YouTube Playlist Archives / {playlist name}`

This is the container form of the personal playlist-archive bot. It does **not** re-upload tracks to YouTube Music. That restore step needs a signed-in browser and is out of scope here.

Use it only for playlists you have the right to archive.

## What it does

- Watchlist: `/data/watchlist.json`
- Already archived video IDs: `/data/archived.json`
- Daily check at `08:22` `America/New_York` inside the web process (`DAILY_CHECK_TIME`). Set `DAILY_CHECK_TIME` empty to disable.
- `CRON_MODE=1` or `node server.js --cron` runs one check and exits (Railway cron service).
- HTTP API on `PORT` (default `8080`), bound to `0.0.0.0`.

`/health` is public. Every other route requires `Authorization: Bearer $API_TOKEN`.

| Method | Path | Body | Behavior |
|---|---|---|---|
| GET | `/health` | | Liveness, Deno presence, last check counts |
| GET | `/watchlist` | | Current watchlist |
| POST | `/watchlist` | `{ "url", "name?", "archive?" }` | Add a playlist. `archive: true` runs the check for that playlist immediately |
| POST | `/check` | | Run the daily check now |
| POST | `/test-download` | `{ "url" }` | Download one video to `/tmp` and report size and codec. Does not upload to Drive or mark it archived. A playlist URL downloads only the first video |

A second check while one is running returns `409`.

## Drive

For personal My Drive uploads, use Google user OAuth. Service accounts have no My Drive quota and cannot upload to personal My Drive folders; they can still use a folder shared with the service account email as **Editor** or a Shared Drive. The app creates `YouTube Playlist Archives / {playlist name}` under `DRIVE_ROOT_FOLDER_ID` (which defaults to `root`).

Credentials, first match wins:

1. `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` — all three must be set for user OAuth
2. `GOOGLE_SERVICE_ACCOUNT_JSON` — the full JSON key as a single-line string
3. `GOOGLE_APPLICATION_CREDENTIALS` — path to the key file

Enable the Google Drive API on the GCP project for the OAuth client or service-account key.

### Set up Google user OAuth

In the Google Cloud Console OAuth client, add this exact redirect URI:

`http://127.0.0.1:8765/oauth2callback`

The required scope is:

`https://www.googleapis.com/auth/drive`

Run the setup helper locally with either environment variables:

```bash
GOOGLE_OAUTH_CLIENT_ID=your-client-id \
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret \
npm run oauth-setup
```

Or pass the values as arguments:

```bash
npm run oauth-setup -- --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
```

It opens the consent URL, listens on `127.0.0.1:8765`, and saves the refresh token to `/workspace/secrets/google-oauth-refresh.json` with mode `600`. Copy the three values from that file to Railway; do not commit the file.

## yt-dlp

Downloads use:

```
yt-dlp -x --audio-format mp3 --audio-quality 0 \
  --embed-thumbnail --embed-metadata --convert-thumbnails jpg \
  --js-runtimes deno:/usr/local/bin/deno
```

Album is forced to the playlist name after download. Artist comes from the YouTube Music artist, then creator, uploader, or channel. If a youtube.com download is unavailable, the same video id is tried once on music.youtube.com.

`YTDLP_EXTRA_ARGS` is appended (quotes supported), for example cookies for private playlists:

```
YTDLP_EXTRA_ARGS=--cookies /data/cookies.txt
```

## Railway

Do not commit secrets. Attach a volume mounted at `/data` so the watchlist survives deploys.

Recommended: one web service (this `railway.toml`) plus the volume. The in-process clock runs the daily check. Leave `CRON_MODE` unset.

Optional cron service from the same image, only if it mounts the **same** data. Railway volumes attach to one service, so a second service does not see `/data` unless you give it its own volume (separate watchlist). Prefer the in-process schedule.

If you do run a cron service:

- Start command: `node server.js --cron`
- `CRON_MODE=1`
- `DAILY_CHECK_TIME=` empty on **both** services if they somehow share data, so the check does not run twice
- Railway cron is UTC. 08:22 America/New_York is `22 12 * * *` during EDT and `22 13 * * *` during EST

```toml
[deploy]
startCommand = "node server.js --cron"
cronSchedule = "22 12 * * *"
```

## Run locally

```bash
npm ci
export DATA_DIR=/tmp/playlist-archive API_TOKEN=dev DAILY_CHECK_TIME=
node server.js
curl -s localhost:8080/health
```

`npm test` covers URL parsing, the JSON store, the scheduler, and bearer auth. It does not call YouTube or Drive.

## Files on the volume

`watchlist.json`

```json
{ "playlists": [{ "id": "", "listId": "", "url": "", "name": "", "addedAt": "", "updatedAt": "" }] }
```

`archived.json`

```json
{ "videos": { "VIDEO_ID": { "id": "", "title": "", "artist": "", "album": "", "driveFileId": "", "archivedAt": "" } } }
```

Video IDs are global. A track archived from one playlist is not downloaded again for another.
