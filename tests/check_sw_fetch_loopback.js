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
 *   - any identifier with MORE THAN ONE `const`/`let`/`var` declaration in
 *     the file (verify M3 2026-07-16: the original first-textual-match
 *     resolution could be defeated by a later shadowing declaration inside
 *     a function - `const HEALTH_ENDPOINT = 'https://evil...'` in an inner
 *     scope resolves to the innocent top-level const textually while the
 *     runtime uses the evil one; a duplicate declaration is therefore
 *     treated as unresolvable and fails closed),
 *   - any reference to bare `fetch` that is not immediately followed by
 *     `(` (verify M4 2026-07-16: aliasing - `const probeFn = fetch;
 *     probeFn(url)` - is invisible to both the call-site scan here and
 *     check_no_egress.sh's `= fetch` grep once the alias is called under
 *     its new name; a strict no-bare-fetch-references rule closes that
 *     whole class, including the `fetch (url)` spaced-call variant this
 *     scan's own call-site regex would otherwise miss),
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

// M3 (fail-closed duplicate handling): resolves `name` to its string
// literal ONLY when the file contains exactly ONE declaration of that name.
// Counting ALL `const`/`let`/`var <name> =` declarations (not just string-
// literal-valued const ones) is the load-bearing part: a later shadowing
// declaration inside a function (`const HEALTH_ENDPOINT = 'https://evil...'`
// in an inner scope) would otherwise be invisible to a first-textual-match
// lookup while being exactly what the runtime uses at that call site.
// Returns {literal} on success, {error} on any ambiguity.
function resolveIdentifierLiteral(name) {
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, 'g');
  const declCount = (src.match(declRe) || []).length;
  if (declCount === 0) {
    return { error: `no const/let/var declaration of "${name}" found in the file` };
  }
  if (declCount > 1) {
    return { error: `${declCount} declarations of "${name}" found - a duplicate/shadowing declaration makes the call target ambiguous (fail closed)` };
  }
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(['"\`][^'"\`]*['"\`])`);
  const m = src.match(re);
  if (!m) {
    return { error: `the single declaration of "${name}" is not a plain quoted string literal` };
  }
  const literal = literalFromQuoted(m[1]);
  if (literal === null) return { error: `could not parse the string literal assigned to "${name}"` };
  return { literal };
}

const fetchCallRe = /\bfetch\(\s*([^,)\s][^,)]*)/g;
let match;
let calls = 0;
const failures = [];

// M4 (aliasing scan, fail-closed): every reference to bare `fetch` in the
// comment-stripped source must be a direct call - `fetch` immediately
// followed by `(`. Anything else (`const probeFn = fetch;`, `[fetch]`,
// `{fetch}`, `fetch.call(...)`, a spaced `fetch (url)` call) is refused
// outright: an alias would let the aliased name make network calls this
// gate's call-site scan below never sees, and a spaced call would slip
// between that scan's `fetch\(` and check_no_egress.sh's own patterns.
// Deliberately no allowlist of "safe-looking" non-call references - there
// is no legitimate reason for this file to mention bare `fetch` any other
// way, so the simplest rule is also the safest one.
const bareFetchRe = /\bfetch\b(?!\()/g;
let aliasMatch;
while ((aliasMatch = bareFetchRe.exec(src))) {
  const start = Math.max(0, aliasMatch.index - 40);
  const context = src.slice(start, aliasMatch.index + 45).replace(/\s+/g, ' ').trim();
  failures.push(`bare "fetch" reference that is not a direct fetch( call - aliasing/indirection is refused (fail closed): ...${context}...`);
}

while ((match = fetchCallRe.exec(src))) {
  calls += 1;
  const arg = match[1].trim();
  let literal = null;
  let resolveError = null;
  if (/^['"`]/.test(arg)) {
    literal = literalFromQuoted(arg);
    if (literal === null) resolveError = 'could not parse the quoted literal';
  } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(arg)) {
    const resolved = resolveIdentifierLiteral(arg);
    if (resolved.literal !== undefined) literal = resolved.literal;
    else resolveError = resolved.error;
  }
  if (literal === null) {
    failures.push(`fetch(${arg}...) - could not resolve to a literal URL string${resolveError ? ` (${resolveError})` : ''}; treated as a violation until it can be verified loopback-only`);
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
