'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir, dailyCheckTime, tz } = require('./config');

function zonedParts(date = new Date(), timeZone = tz()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = String(parts.hour).padStart(2, '0');
  if (hour === '24') hour = '00';
  const minute = String(parts.minute).padStart(2, '0');
  return {
    hhmm: `${hour}:${minute}`,
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function statePath() {
  return path.join(dataDir(), 'scheduler-state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n');
}

/** True once per local calendar day, at or after DAILY_CHECK_TIME. */
function isDue(now = new Date()) {
  const scheduled = normalizeTime(dailyCheckTime());
  if (!scheduled) return { due: false, reason: 'disabled' };
  const parts = zonedParts(now);
  if (parts.hhmm < scheduled) return { due: false, reason: 'before-time', ...parts, scheduled };
  const state = readState();
  if (state.lastDay === parts.day) return { due: false, reason: 'already-ran', ...parts, scheduled };
  return { due: true, ...parts, scheduled };
}

function markRan(day) {
  const state = readState();
  state.lastDay = day;
  state.ranAt = new Date().toISOString();
  writeState(state);
}

module.exports = { zonedParts, normalizeTime, isDue, markRan };
