#!/usr/bin/env node
'use strict';
/**
 * tests/check_sw_fetch_loopback.js - companion to check_no_egress.sh (P4,
 * LFL-TERMINAL-MEMBER-EXPERIENCE-DESIGN.md §6, owner sign-off E condition:
 * Fable security review of this exact posture change).
 *
 * check_no_egress.sh's grep-based gate only proves network-capable APIs
 * stay confined to extension/background/service-worker.js - it says
 * nothing about WHERE inside that one file a fetch() call is allowed to
 * point. Before E5, that file had exactly one fetch() call site (the
 * model-lane call in callLocalModelWithPayload()), so "confined to this
 * file" and "confined to the loopback model endpoint" were the same fact.
 * E5 adds a second call site (the /health and /v1/models status check), so
 * the posture this gate must hold widens from "exactly one call site" to
 * "every call site, individually proven loopback-only".
 *
 * Resolves EVERY fetch(...) call site's first argument in
 * extension/background/service-worker.js to a literal string - either
 * directly (a quoted literal passed straight to fetch()), or by following
 * the ONE level of indirection this file's call sites actually use (a
 * bare identifier that is a `const NAME = '...'`/`"..."`/`` `...` ``
 * assignment elsewhere in the file) - and asserts every resolved literal
 * starts with a 127.0.0.1 loopback origin (http:// or https://, with or
 * without an explicit port). Fails loudly (nonzero exit, one line per
 * offender) on:
 *   - any resolved literal that is not a 127.0.0.1 loopback URL,
 *   - any fetch(...) call whose first argument this script cannot resolve
 *     to a literal at all (an unresolvable target is treated as a
 *     violation, not silently skipped - a gate that can be defeated by
 *     making the target harder to read is worse than no gate),
 *   - zero fetch(...) call sites found at all (a gate that never actually
 *     checks anything must fail loudly, not pass silently).
 *
 * Deliberately does NOT do this for the whole extension/ tree - other
 * *.js files in extension/ are not allowed to call fetch() at all
 * (check_no_egress.sh's own job), so there is nothing here for this
 * script to resolve outside service-worker.js.
 *
 * Accepts an optional path argument (defaults to the real
 * service-worker.js) so a canary proof can point this script at a scratch
 * copy with a deliberately-planted non-loopback fetch() call, without
 * touching the real file - see this feature's build notes for that proof;
 * the canary itself is never committed.
 *
 * Run: node tests/check_sw_fetch_loopback.js [path-to-service-worker.js]
 * Exit 0 = every fetch() call site resolved loopback-only, nonzero = a
 * violation (or nothing to check) was found.
 */

const fs = require('fs');
const path = require('path');

const SW_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'extension', 'background', 'service-worker.js');

const rawSrc = fs.readFileSync(SW_PATH, 'utf8');

// Strips `//` and `/* */` comments while leaving string/template literal
// CONTENTS untouched - a naive `s.replace(/\/\/.*/g, '')` would wrongly
// treat the "//" inside a literal like 'http://127.0.0.1:1238/health' as a
// line comment. A small state machine instead: only interprets `//`/`/*`
// as a comment start while NOT inside a quote, so this file's own doc
// comments (which literally say `fetch(...)` in prose, as this file's own
// header does) never leak a fake call site into the regex below, while
// every real string literal - including its "//" - survives byte-for-byte.
function stripComments(s) {
  let out = '';
  let i = 0;
  let quote = null; // null | "'" | '"' | '`'
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next || ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const src = stripComments(rawSrc);

const LOOPBACK_RE = /^https?:\/\/127\.0\.0\.1(:\d+)?\//;

function literalFromQuoted(raw) {
  const q = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== q) return null;
  return raw.slice(1, -1);
}

function resolveIdentifierLiteral(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(['"\`][^'"\`]*['"\`])`);
  const m = src.match(re);
  if (!m) return null;
  return literalFromQuoted(m[1]);
}

const fetchCallRe = /\bfetch\(\s*([^,)\s][^,)]*)/g;
let match;
let calls = 0;
const failures = [];

while ((match = fetchCallRe.exec(src))) {
  calls += 1;
  const arg = match[1].trim();
  let literal = null;
  if (/^['"`]/.test(arg)) {
    literal = literalFromQuoted(arg);
  } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg)) {
    literal = resolveIdentifierLiteral(arg);
  }
  if (literal === null) {
    failures.push(`fetch(${arg}...) - could not resolve to a literal URL string; treated as a violation until it can be verified loopback-only`);
    continue;
  }
  if (!LOOPBACK_RE.test(literal)) {
    failures.push(`fetch(${arg}...) resolves to "${literal}" - not a 127.0.0.1 loopback URL`);
  }
}

if (calls === 0) {
  console.error(`FAIL: found zero fetch(...) call sites in ${SW_PATH} - this gate has nothing to check (update it if fetch is now called some other way).`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`FAIL: non-loopback (or unresolvable) fetch target(s) in ${SW_PATH}:`);
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}

console.log(`PASS: all ${calls} fetch() call site(s) in ${path.basename(SW_PATH)} resolve to a 127.0.0.1 loopback URL.`);
