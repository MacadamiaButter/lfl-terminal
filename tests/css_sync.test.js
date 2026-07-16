#!/usr/bin/env node
/**
 * tests/css_sync.test.js - mechanical drift gate for the hand-synced CSS pair
 * (FOUNDATIONS-SPRINT-2026-07-16.md F1). extension/content/terminal.css is
 * the canonical source; terminal.js carries a duplicate as its CSS_TEXT
 * template literal, injected straight into the shadow root (TODO(M2) note in
 * both files: no-build-step is a hard M1 constraint, so the duplication
 * stays until a tiny build step lands - this test is the guard in the
 * meantime). This suite extracts CSS_TEXT with a strict regex, parses BOTH
 * sources into {selector -> {property -> value}} maps with a deliberately
 * dumb, flat-rules-only parser, and diffs them in both directions: every
 * selector+property in each must exist and match, byte-for-byte after value
 * normalization, in the other.
 *
 * The parser is dumb ON PURPOSE - it guards THIS pair of files, not general
 * CSS. Both files contain only simple flat rules today (no nesting, no
 * @media/@supports/etc). If either source ever grows one, this test must
 * FAIL LOUDLY with a message saying the parser needs updating, never
 * mis-parse and silently pass. Likewise, if CSS_TEXT is ever renamed or its
 * shape changes so the extraction regex stops matching, that is a TEST
 * FAILURE, not a skip.
 *
 * House style note: this file (like every tracked file in this repo) must
 * contain zero U+2014 (em dash) characters - see tests/check_no_emdash.sh.
 *
 * Run: node tests/css_sync.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TERMINAL_JS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const TERMINAL_CSS_PATH = path.join(ROOT, 'extension', 'content', 'terminal.css');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${e && e.message ? e.message : e}`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Matches: const CSS_TEXT = `\n...css...\n`;
// Deliberately anchored to the exact shape used in terminal.js today. If the
// constant is renamed, reformatted onto one line, or the backtick/semicolon
// wrapper changes, this must fail to match - see the extraction check below,
// which turns a non-match into a hard failure rather than an empty pass.
const CSS_TEXT_RE = /const CSS_TEXT = `\n([\s\S]*?)`;/;

// Strip /* ... */ comments. Applied to both sources for symmetry (CSS_TEXT
// is minified and should never contain a comment in practice, but treating
// both texts identically avoids a silent asymmetry in the parser itself).
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Normalize a selector (or comma-separated selector group) for comparison:
// collapse all whitespace/newlines to single spaces, then normalize the
// spacing around "," and the combinators > + ~ so formatting differences
// between the hand-authored .css file and the minified CSS_TEXT copy never
// register as a mismatch.
function normalizeSelector(sel) {
  let s = sel.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*,\s*/g, ', ');
  s = s.replace(/\s*([>+~])\s*/g, ' $1 ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Normalize a declaration value for comparison: collapse whitespace, tighten
// spacing around commas, and canonicalize "0.6" vs ".6" (always add the
// leading zero) so the two files' formatting conventions never cause a
// false-positive mismatch.
function normalizeValue(val) {
  let v = val.replace(/\s+/g, ' ').trim();
  v = v.replace(/\s*,\s*/g, ', ');
  v = v.replace(/(^|[^0-9])\.(\d)/g, '$10.$2');
  return v;
}

// Split a (comment-stripped) block of CSS text into {selector, body} rule
// pairs by walking brace depth by hand. Deliberately strict: this is not a
// real CSS parser. It understands exactly one shape - flat "selector {
// prop: value; ... }" rules, no nesting, no at-rules - and throws a loud,
// specific error the moment it sees anything else, instead of guessing.
function splitRules(text, label) {
  const rules = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i += 1;
    if (i >= n) break;
    const selStart = i;
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) {
      const rest = text.slice(i).trim();
      if (rest.length > 0) {
        throw new Error(
          `${label}: trailing content after the last rule with no "{" to open a body: "${rest.slice(0, 80)}"`
        );
      }
      break;
    }
    const selectorRaw = text.slice(selStart, braceIdx);
    if (selectorRaw.includes('@')) {
      throw new Error(
        `${label}: at-rule detected near selector "${selectorRaw.trim()}" - this parser only ` +
          'understands flat rules; it needs updating before it can handle @media/@supports/etc.'
      );
    }
    let j = braceIdx + 1;
    while (j < n && text[j] !== '{' && text[j] !== '}') j += 1;
    if (j >= n) {
      throw new Error(
        `${label}: unterminated rule body (no closing "}") for selector "${selectorRaw.trim()}"`
      );
    }
    if (text[j] === '{') {
      throw new Error(
        `${label}: nested "{" found inside the rule body for selector "${selectorRaw.trim()}" - ` +
          'this parser only understands flat, non-nested rules and needs updating for nesting.'
      );
    }
    const body = text.slice(braceIdx + 1, j);
    rules.push({ selector: selectorRaw, body });
    i = j + 1;
  }
  return rules;
}

// Turn {selector, body} rule pairs into a Map<normalizedSelector,
// {prop: normalizedValue}>. Also strict: a declaration with no ":" is a
// parse error, not something to skip, and a selector repeated as a second,
// separate rule is a shape this parser does not understand (real CSS would
// merge/override; that is not what either source file does today).
function buildPropertyMap(rules, label) {
  const map = new Map();
  for (const { selector, body } of rules) {
    const normSel = normalizeSelector(selector);
    if (normSel.length === 0) {
      throw new Error(`${label}: empty selector immediately before a rule body`);
    }
    const props = {};
    const decls = body.split(';');
    for (const rawDecl of decls) {
      const decl = rawDecl.trim();
      if (decl.length === 0) continue;
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `${label}: malformed declaration (no ":") in selector "${normSel}": "${decl}"`
        );
      }
      const prop = decl.slice(0, colonIdx).trim();
      const rawValue = decl.slice(colonIdx + 1).trim();
      props[prop] = normalizeValue(rawValue);
    }
    if (map.has(normSel)) {
      throw new Error(
        `${label}: selector "${normSel}" appears in more than one separate rule - this parser ` +
          'does not merge repeated selectors and needs updating if that becomes intentional.'
      );
    }
    map.set(normSel, props);
  }
  return map;
}

// Every selector+property in fromMap must exist, with an identical
// normalized value, in toMap. Returns an array of human-readable mismatch
// strings (empty = clean match). Failure strings always name the selector,
// the property, and both sides' values (or say which side lacks the
// selector entirely), per the spec.
function compareMaps(fromMap, fromLabel, toMap, toLabel) {
  const mismatches = [];
  for (const [selector, props] of fromMap.entries()) {
    if (!toMap.has(selector)) {
      mismatches.push(`selector "${selector}" is in ${fromLabel} but missing entirely from ${toLabel}`);
      continue;
    }
    const otherProps = toMap.get(selector);
    for (const [prop, value] of Object.entries(props)) {
      if (!(prop in otherProps)) {
        mismatches.push(
          `selector "${selector}" property "${prop}" is in ${fromLabel} (value "${value}") but missing from ${toLabel}`
        );
      } else if (otherProps[prop] !== value) {
        mismatches.push(
          `selector "${selector}" property "${prop}" mismatch: ${fromLabel}="${value}" vs ${toLabel}="${otherProps[prop]}"`
        );
      }
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// shared state threaded through the checks below (each check populates what
// the next one needs; a failure upstream must not crash downstream checks
// with a confusing raw TypeError, it must produce its own clear FAIL line)
// ---------------------------------------------------------------------------

let cssTextRaw = null;
let cssFileRaw = null;
let cssTextMap = null;
let cssFileMap = null;

console.log('\n[0] CSS_TEXT extraction');

check('CSS_TEXT is extracted from terminal.js and is non-empty', () => {
  const src = fs.readFileSync(TERMINAL_JS_PATH, 'utf8');
  const m = CSS_TEXT_RE.exec(src);
  if (!m) {
    throw new Error(
      'const CSS_TEXT = `...`; not found in terminal.js (regex did not match) - ' +
        'the constant may have been renamed or reformatted; this is a gate failure, not a skip.'
    );
  }
  const body = m[1];
  assert.ok(body && body.trim().length > 0, 'CSS_TEXT body extracted but empty');
  cssTextRaw = body;
});

console.log('\n[1] parser strictness - no at-rules or nesting in either source');

check('terminal.css and CSS_TEXT both parse as flat rules with no @-rules or nesting', () => {
  assert.ok(cssTextRaw !== null, 'CSS_TEXT was not extracted in the previous check - cannot parse it');
  cssFileRaw = fs.readFileSync(TERMINAL_CSS_PATH, 'utf8');

  const cssTextClean = stripComments(cssTextRaw);
  const cssFileClean = stripComments(cssFileRaw);

  const cssTextRules = splitRules(cssTextClean, 'CSS_TEXT');
  const cssFileRules = splitRules(cssFileClean, 'terminal.css');

  assert.ok(cssTextRules.length > 0, 'CSS_TEXT parsed to zero rules');
  assert.ok(cssFileRules.length > 0, 'terminal.css parsed to zero rules');

  cssTextMap = buildPropertyMap(cssTextRules, 'CSS_TEXT');
  cssFileMap = buildPropertyMap(cssFileRules, 'terminal.css');
});

console.log('\n[2] dual-sync diff (both directions)');

check('every CSS_TEXT rule exists in terminal.css with identical properties', () => {
  assert.ok(cssTextMap !== null && cssFileMap !== null, 'parsing did not succeed in the previous check');
  const mismatches = compareMaps(cssTextMap, 'CSS_TEXT', cssFileMap, 'terminal.css');
  if (mismatches.length > 0) {
    throw new Error(`${mismatches.length} mismatch(es):\n         ` + mismatches.join('\n         '));
  }
});

check('every terminal.css rule exists in CSS_TEXT with identical properties', () => {
  assert.ok(cssTextMap !== null && cssFileMap !== null, 'parsing did not succeed in an earlier check');
  const mismatches = compareMaps(cssFileMap, 'terminal.css', cssTextMap, 'CSS_TEXT');
  if (mismatches.length > 0) {
    throw new Error(`${mismatches.length} mismatch(es):\n         ` + mismatches.join('\n         '));
  }
});

console.log(`\ncss_sync: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
