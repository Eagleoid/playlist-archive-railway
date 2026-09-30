'use strict';

/** Split a shell-like arg string. Supports double and single quotes. No expansions. */
function splitArgs(input) {
  if (!input || !String(input).trim()) return [];
  const s = String(input);
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    cur += ch;
  }
  if (quote) {
    throw new Error('YTDLP_EXTRA_ARGS has an unterminated quote');
  }
  if (cur) out.push(cur);
  return out;
}

function extraArgs() {
  return splitArgs(process.env.YTDLP_EXTRA_ARGS || '');
}

module.exports = { splitArgs, extraArgs };
