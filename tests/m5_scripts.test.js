#!/usr/bin/env node
/**
 * tests/m5_scripts.test.js - unit proof of scripts v1 (registry.js's
 * parseScriptBody/substituteParams/tokenizeArgs + createAliasStore's
 * setScript/getScript/listScripts/unsetScript), against the REAL,
 * unmodified extension/content/registry.js source (plain CommonJS require -
 * no DOM dependency, same posture as tests/panel_resize.test.js/
 * tests/autoopen.test.js).
 *
 * Design doc: LFL-TERMINAL-SCRIPTS-DESIGN.md. This file proves the §1
 * governing constraint ("a saved script may only ever contain steps a human
 * could approve one at a time") and the §4 injection-safe substitution
 * contract at the pure-function level; the DOM (plan-preview approval card,
 * the `script new` line-buffered editor, pause/continue queue parking) lives
 * in terminal.js and is exercised by the manual live-browser smoke (design
 * doc §7).
 *
 * Run: node tests/m5_scripts.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'extension', 'content', 'registry.js'));

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

function fakeStorageArea() {
  let store = {};
  return {
    get(keys, cb) {
      const out = {};
      keys.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
      cb(out);
    },
    set(obj) { store = Object.assign({}, store, obj); },
  };
}

// =====================================================================
// [0] parseScriptBody - line/comment parsing, step cap
// =====================================================================
console.log('\n[0] parseScriptBody - line/comment parsing, step cap');

check('one step per line; blank lines and # comments ignored', () => {
  const p = registry.parseScriptBody('go example.com\n\n# a comment\nsearch "socks"\n');
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.steps, ['go example.com', 'search "socks"']);
  assert.strictEqual(p.stepCount, 2);
});

check('empty body (all blank/comments) is rejected', () => {
  const p = registry.parseScriptBody('\n# just a comment\n\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /no steps/);
});

check('more than maxSteps is rejected, nothing partially accepted', () => {
  const body = Array.from({ length: 21 }, (_, i) => `go example${i}.com`).join('\n');
  const p = registry.parseScriptBody(body, { maxSteps: 20 });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /too many steps \(21, max 20\)/);
});

check('exactly maxSteps is accepted', () => {
  const body = Array.from({ length: 20 }, (_, i) => `go example${i}.com`).join('\n');
  const p = registry.parseScriptBody(body, { maxSteps: 20 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.stepCount, 20);
});

// =====================================================================
// [1] index-verb rejection at define time (design doc §1, the governing
// constraint) - click/select always; fill/open only in their NUMERIC form;
// the bare-number M4a shortcut; label/text forms remain allowed.
// =====================================================================
console.log('\n[1] index-verb rejection (§1 governing constraint) - click/fill[N]/select/open[N]/bare-number blocked, label/text forms allowed');

check('click <N> is always rejected', () => {
  const p = registry.parseScriptBody('go example.com\nclick 4\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /ls-listing index/);
  assert.match(p.reason, /use pause/);
});

check('select <N> is always rejected (future-proofing, no typed verb exists yet)', () => {
  const p = registry.parseScriptBody('select 2\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /ls-listing index/);
});

check('fill <N> with ... is rejected (numeric index form)', () => {
  const p = registry.parseScriptBody('fill 3 with hello\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /fill <N>/);
});

check('fill <label> with ... is ALLOWED (resolved fresh each run, not snapshot-bound)', () => {
  const p = registry.parseScriptBody('fill email with test@example.com\n');
  assert.strictEqual(p.ok, true);
});

check('open <N> is rejected (numeric ls-index form)', () => {
  const p = registry.parseScriptBody('open 7\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /open <N>/);
});

check('open <link text> is ALLOWED (resolved fresh each run)', () => {
  const p = registry.parseScriptBody('open Contact Us\n');
  assert.strictEqual(p.ok, true);
});

check('a bare number (M4a index shortcut) is rejected', () => {
  const p = registry.parseScriptBody('go example.com\n4\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /bare number/);
});

check('the rejection message names the step number, 1-indexed', () => {
  const p = registry.parseScriptBody('go example.com\nsearch "x"\nclick 1\n');
  assert.match(p.reason, /^step 3:/);
});

// =====================================================================
// [2] pause syntax + games/funpack/nested-run write-time locks
// =====================================================================
console.log('\n[2] pause syntax validation + games/funpack/nested-run locks');

check('pause with a quoted instruction is accepted and not treated as index-addressed', () => {
  const p = registry.parseScriptBody('go example.com\npause "click the buy button"\n');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.steps[1], 'pause "click the buy button"');
});

check('pause without a quoted instruction is rejected', () => {
  const p = registry.parseScriptBody('pause click the button\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /quoted instruction/);
});

check('pause with an empty quoted string is rejected (non-empty required)', () => {
  const p = registry.parseScriptBody('pause ""\n');
  assert.strictEqual(p.ok, false);
});

check('a game name as a step is rejected (same lock as macros)', () => {
  const p = registry.parseScriptBody('go example.com\nsnake\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /games are never chain\/script-eligible/);
});

check('a funpack name as a step is rejected (same lock as macros)', () => {
  const p = registry.parseScriptBody('go example.com\nfortune\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /does not run in chains or scripts/);
});

check('a script may not invoke another script ("run") - depth-1 lock', () => {
  const p = registry.parseScriptBody('go example.com\nrun other-script\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /may not be nested \(depth-1 lock\)/);
});

// =====================================================================
// [3] arity / usesRest computation
// =====================================================================
console.log('\n[3] arity / usesRest computation from $1..$9 / $@ references');

check('no params -> arity 0, usesRest false', () => {
  const p = registry.parseScriptBody('go example.com\n');
  assert.strictEqual(p.arity, 0);
  assert.strictEqual(p.usesRest, false);
});

check('arity is the MAX numbered param referenced across all steps', () => {
  const p = registry.parseScriptBody('go example.com\nsearch "$1"\nfill email with "$3"\n');
  assert.strictEqual(p.arity, 3);
});

check('$@ sets usesRest without affecting numbered arity', () => {
  const p = registry.parseScriptBody('search $@\n');
  assert.strictEqual(p.arity, 0);
  assert.strictEqual(p.usesRest, true);
});

// =====================================================================
// [4] tokenizeArgs - quote-aware `run <name> [args...]` tokenizer
// =====================================================================
console.log('\n[4] tokenizeArgs - quote-aware whitespace tokenizer');

check('bare words split on whitespace', () => {
  const t = registry.tokenizeArgs('2 foo bar');
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(t.tokens.map((x) => x.value), ['2', 'foo', 'bar']);
  assert.deepStrictEqual(t.tokens.map((x) => x.raw), ['2', 'foo', 'bar']);
});

check('a quoted argument is one token; raw preserves the quotes', () => {
  const t = registry.tokenizeArgs('2 "gift wrap"');
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.tokens.length, 2);
  assert.strictEqual(t.tokens[1].value, 'gift wrap');
  assert.strictEqual(t.tokens[1].raw, '"gift wrap"');
});

check('an unterminated quote is rejected, not silently truncated', () => {
  const t = registry.tokenizeArgs('foo "unterminated');
  assert.strictEqual(t.ok, false);
  assert.match(t.reason, /unterminated/);
});

check('empty input yields zero tokens, not an error', () => {
  const t = registry.tokenizeArgs('');
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(t.tokens, []);
});

// =====================================================================
// [5] substituteParams - the injection-safe substitution matrix (design
// doc §4, normative). This is the heaviest test target: structure is fixed
// on the TEMPLATE before this runs, so a value can never create a new step.
// =====================================================================
console.log('\n[5] substituteParams - injection-safe substitution matrix');

check('a $1..$9 reference is replaced with the plain arg value', () => {
  const s = registry.substituteParams('search "$1"', [{ value: 'socks', raw: 'socks' }]);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.text, 'search "socks"');
});

check('&& inside an argument VALUE stays inert - no new step is created', () => {
  const tok = registry.tokenizeArgs('"foo && open evil.com"');
  const s = registry.substituteParams('search "$1"', tok.tokens);
  assert.strictEqual(s.ok, true);
  // exactly one command's worth of text, the && is just literal characters now
  assert.strictEqual(s.text, 'search "foo && open evil.com"');
  assert.strictEqual(s.text.split('&&').length - 1, 1); // present but inert, not re-split anywhere in this path
});

check('a value containing a " character is rejected, not patched', () => {
  const s = registry.substituteParams('fill x with "$1"', [{ value: 'a"b', raw: 'a"b' }]);
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /cannot be safely substituted/);
});

check('$@ expands to the original quote-preserving arg string, joined', () => {
  const tok = registry.tokenizeArgs('2 "gift wrap"');
  const s = registry.substituteParams('search $@', tok.tokens);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.text, 'search 2 "gift wrap"');
});

check('an unbound $k (arg not supplied) fails this step with a clear reason', () => {
  const tok = registry.tokenizeArgs('a b');
  const s = registry.substituteParams('search "$5"', tok.tokens);
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /\$5 was not supplied/);
});

check('$10 is $1 followed by a literal "0", NOT a tenth parameter (documented, not a bug)', () => {
  const s = registry.substituteParams('go $10', [{ value: 'X', raw: 'X' }]);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.text, 'go X0');
});

check('multiple params across one step all substitute correctly', () => {
  const tok = registry.tokenizeArgs('a b c');
  const s = registry.substituteParams('fill $1 with "$2 $3"', tok.tokens);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.text, 'fill a with "b c"');
});

check('a step with no param tokens is returned unchanged', () => {
  const s = registry.substituteParams('go example.com', []);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.text, 'go example.com');
});

// =====================================================================
// [6] createAliasStore - setScript/getScript/listScripts/unsetScript,
// name-collision cross-checks ("one name, one thing", §9 sign-off #8), and
// the run-only namespace isolation from built-in verbs (§3).
// =====================================================================
console.log('\n[6] createAliasStore - script CRUD, name-collision cross-checks, run-only namespace isolation');

check('setScript stores a valid script; getScript/listScripts round-trip', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const res = store.setScript('checkout', 'go example.com\nsearch "$1"\n');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stepCount, 2);
  assert.strictEqual(res.arity, 1);
  const got = store.getScript('checkout');
  assert.strictEqual(got.stepCount, 2);
  assert.strictEqual(got.arity, 1);
  assert.deepStrictEqual(Object.keys(store.listScripts()), ['checkout']);
});

check('getScript on an undefined name returns null (not undefined/throw)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.getScript('nope'), null);
});

check('unsetScript removes it; unsetting a nonexistent script fails cleanly', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setScript('checkout', 'go example.com\n');
  assert.strictEqual(store.unsetScript('checkout').ok, true);
  assert.strictEqual(store.getScript('checkout'), null);
  assert.strictEqual(store.unsetScript('checkout').ok, false);
});

check('an invalid script body is rejected and never stored', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const res = store.setScript('bad', 'click 4\n');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(store.getScript('bad'), null);
});

check('a script MAY be named after an ordinary built-in verb - run-only invocation isolates it (design doc §3)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setScript('search', 'go example.com\n').ok, true);
  assert.strictEqual(store.setScript('open', 'go example.com\n').ok, true);
});

check('a script may NOT be named "run"/"script"/"pause" - the script system\'s own self-referential names', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  for (const bad of ['run', 'script', 'pause']) {
    const res = store.setScript(bad, 'go example.com\n');
    assert.strictEqual(res.ok, false, `expected "${bad}" to be rejected as a script name`);
    assert.match(res.reason, /script-system command/);
  }
});

check('one flat namespace: a script cannot collide with an existing alias', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setAlias('wiki', 'go en.wikipedia.org').ok, true);
  const res = store.setScript('wiki', 'go example.com\n');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /already an alias name/);
});

check('one flat namespace: a script cannot collide with an existing macro', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setMacro('morning', 'go example.com && search "news"').ok, true);
  const res = store.setScript('morning', 'go example.com\n');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /already a macro name/);
});

check('one flat namespace, the reverse direction: an alias cannot collide with an existing script', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setScript('checkout', 'go example.com\n').ok, true);
  const res = store.setAlias('checkout', 'go example.com');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /already a script name/);
});

check('one flat namespace, the reverse direction: a macro cannot collide with an existing script', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setScript('checkout', 'go example.com\n').ok, true);
  const res = store.setMacro('checkout', 'go example.com && search "x"');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /already a script name/);
});

check('checkNameAvailable agrees with setScript on the same inputs (built-in verb ok, self-name blocked, collision blocked)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setAlias('wiki', 'go en.wikipedia.org');
  assert.strictEqual(store.checkNameAvailable('search').ok, true);
  assert.strictEqual(store.checkNameAvailable('run').ok, false);
  assert.strictEqual(store.checkNameAvailable('wiki').ok, false);
});

// =====================================================================
// [7] registry-cannot-extend-model-vocabulary companion: script/run/pause
// are reserved (an alias/macro can never shadow them) - the model-schema
// half of this guarantee is proven separately in tests/m3_hardening.test.js.
// =====================================================================
console.log('\n[7] script/run/pause are reserved against alias/macro shadowing');

check('an alias cannot be named "script"/"run"/"pause"', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  for (const name of ['script', 'run', 'pause']) {
    const res = store.setAlias(name, 'go example.com');
    assert.strictEqual(res.ok, false, `expected alias "${name}" to be rejected`);
  }
});

check('a macro cannot be named "script"/"run"/"pause"', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  for (const name of ['script', 'run', 'pause']) {
    const res = store.setMacro(name, 'go example.com && search "x"');
    assert.strictEqual(res.ok, false, `expected macro "${name}" to be rejected`);
  }
});

// =====================================================================
// [8] Verify-pass fixes (2026-07-14 Fable) - validateResolvedStep: the
// post-substitution/post-alias-expansion re-validation that closes the
// head-position-parameter and alias-indirection resurrections of
// index-addressed steps (§1's governing constraint, applied at RUN time,
// not just define time).
// =====================================================================
console.log('\n[8] validateResolvedStep - run-time re-validation (head-position params, alias indirection)');

check('a head-position parameter cannot resurrect an index click: "$1" resolved with arg "click 4" is rejected', () => {
  // template `$1` passes parseScriptBody (head "$1" is not an index verb) -
  // the resurrection only becomes visible after substitution, which is
  // exactly where validateResolvedStep runs.
  const p = registry.parseScriptBody('go example.com\n$1\n');
  assert.strictEqual(p.ok, true, 'the TEMPLATE is legal - that is the point');
  const sub = registry.substituteParams('$1', [{ value: 'click 4', raw: '"click 4"' }]);
  assert.strictEqual(sub.ok, true);
  const v = registry.validateResolvedStep(sub.text);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /ls-listing index/);
});

check('an alias-shaped resolution to an index verb is rejected (caller passes the alias-EXPANDED text)', () => {
  // terminal.js expands aliases before calling validateResolvedStep - this
  // pins the contract on the expanded text: "click 4" in, rejected out.
  const v = registry.validateResolvedStep('click 4');
  assert.strictEqual(v.ok, false);
});

check('a bare-number resolution is rejected', () => {
  assert.strictEqual(registry.validateResolvedStep('7').ok, false);
});

check('nested run / script heads are rejected post-indirection', () => {
  assert.strictEqual(registry.validateResolvedStep('run other').ok, false);
  assert.strictEqual(registry.validateResolvedStep('script rm x').ok, false);
});

check('game and funpack heads are rejected post-indirection (preview-time; dispatch fromChain blocks remain the backstop)', () => {
  assert.strictEqual(registry.validateResolvedStep('snake').ok, false);
  assert.strictEqual(registry.validateResolvedStep('fortune').ok, false);
});

check('a malformed pause (unquoted) is rejected; the well-formed shape passes', () => {
  assert.strictEqual(registry.validateResolvedStep('pause click it').ok, false);
  assert.strictEqual(registry.validateResolvedStep('pause "click it"').ok, true);
});

check('ordinary resolved steps pass: go/search/fill-by-label/open-by-text', () => {
  for (const s of ['go example.com', 'search "socks"', 'fill email with x@y.z', 'open Contact Us']) {
    const v = registry.validateResolvedStep(s);
    assert.strictEqual(v.ok, true, `expected "${s}" to pass`);
  }
});

// =====================================================================
// [8b] Verb whitelist (2026-07-14, brainstorm-probe hardening) - setScript
// rejects a step whose leading word is not a known command, a defined alias,
// or `ask`. Enforced only when createAliasStore was given a knownVerbs list
// (production passes LFL.commandRegistry.names(); collision/parse unit tests
// omit it and are unaffected). Closes the gap the lab probe surfaced:
// parseScriptBody alone accepts a nonsense verb like `dance now`.
// =====================================================================
console.log('\n[8b] verb whitelist - setScript refuses unknown / implicit-NL verbs when a known-verb list is supplied');

const WHITELIST_VERBS = ['go', 'search', 'open', 'scroll', 'find', 'fill', 'pause', 'read'];

check('with a known-verb list, a nonsense verb is rejected (the probe finding)', () => {
  const store = registry.createAliasStore(fakeStorageArea(), WHITELIST_VERBS);
  const res = store.setScript('bad', 'dance now');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /not a known command/);
  assert.strictEqual(store.getScript('bad'), null);
});

check('an implicit natural-language step (unknown leading word) is rejected; prefix with ask', () => {
  const store = registry.createAliasStore(fakeStorageArea(), WHITELIST_VERBS);
  assert.strictEqual(store.setScript('nl', 'book the flight').ok, false);
  assert.strictEqual(store.setScript('ok', 'ask book the flight').ok, true); // ask is always allowed
});

check('known verbs, a defined alias, and go/pause all pass the whitelist', () => {
  const store = registry.createAliasStore(fakeStorageArea(), WHITELIST_VERBS);
  store.setAlias('wiki', 'go en.wikipedia.org');
  assert.strictEqual(store.setScript('a', 'go example.com\nsearch "socks"\npause "click it"').ok, true);
  assert.strictEqual(store.setScript('b', 'wiki').ok, true); // alias by name
});

check('WITHOUT a known-verb list the whitelist is skipped (backward compat for collision/parse tests)', () => {
  const store = registry.createAliasStore(fakeStorageArea()); // no knownVerbs
  assert.strictEqual(store.setScript('x', 'dance now').ok, true);
});

check('the whitelist runs AFTER parseScriptBody, so index/games messages still win for their cases', () => {
  const store = registry.createAliasStore(fakeStorageArea(), WHITELIST_VERBS.concat(['click', 'snake']));
  // click is a "known" verb but index-addressed -> parseScriptBody's index message, not the whitelist's
  assert.match(store.setScript('i', 'click 4').reason, /ls-listing index/);
});

check('import (via setScript) inherits the whitelist: a shared file with a nonsense-verb step is skipped', () => {
  const store = registry.createAliasStore(fakeStorageArea(), WHITELIST_VERBS);
  const file = '#!lflscript v1\n#!script evil\ngo example.com\ndance now\n';
  const parsed = registry.parseScriptFile(file);
  assert.strictEqual(parsed.ok, true); // structurally fine
  // the importer feeds each body to setScript, which now whitelists
  const res = store.setScript(parsed.scripts[0].name, parsed.scripts[0].body);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /not a known command/);
  assert.strictEqual(store.getScript('evil'), null);
});

// =====================================================================
// [9] brainstorm lane (2026-07-15, LFL-TERMINAL-BRAINSTORM-LANE-DESIGN.md) -
// registry.js locks: teach is reserved, excluded from the script-step
// surface (typed AND imported, structurally - not just a whitelist miss),
// and validateScriptBody()/setScript() give the identical verdict a fake
// drafted-model-response body would get (the "validation path" proof, design
// doc §7 gate item 3: a bad draft is rejected and never persisted; a good
// draft validates but is NOT written until the real write path - what
// terminal.js's approval flow calls - actually runs).
// =====================================================================
console.log('\n[9] brainstorm lane - teach reserved, excluded from script steps (typed + imported), validation-path proof');

check('teach is reserved: cannot be an alias name', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setAlias('teach', 'go example.com').ok, false);
});

check('teach is reserved: cannot be a macro name', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  assert.strictEqual(store.setMacro('teach', 'go example.com').ok, false);
});

check('teach as a script step is rejected at DEFINE time (the typed "script new" path, via parseScriptBody)', () => {
  const p = registry.parseScriptBody('go example.com\nteach do something\n');
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /brainstorm lane is never chain\/script-eligible/);
});

check('teach as a script step is rejected even when a known-verb list INCLUDES "teach" (structural exclusion, not merely a whitelist miss - the SCRIPT_SELF_NAMES pattern)', () => {
  const store = registry.createAliasStore(fakeStorageArea(), ['go', 'search', 'teach']);
  const res = store.setScript('bad', 'go example.com\nteach do something\n');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /brainstorm lane is never chain\/script-eligible/);
  assert.strictEqual(store.getScript('bad'), null);
});

check('teach as a script step is rejected via IMPORT too (parseScriptFile -> setScript path)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const file = '#!lflscript v1\n#!script evil\ngo example.com\nteach draft another script\n';
  const parsed = registry.parseScriptFile(file);
  assert.strictEqual(parsed.ok, true); // structurally fine - the file format itself has no opinion on step content
  const res = store.setScript(parsed.scripts[0].name, parsed.scripts[0].body);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /brainstorm lane is never chain\/script-eligible/);
  assert.strictEqual(store.getScript('evil'), null);
});

check('validateResolvedStep rejects "teach ..." post-indirection, same as run/script', () => {
  assert.strictEqual(registry.validateResolvedStep('teach draft something').ok, false);
});

check('validation-path unit: a fake drafted-model body containing "click 3" is rejected with the index-address reason, and is never persisted by validateScriptBody() or setScript()', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const fakeModelBody = 'go example.com\nclick 3\n'; // what a poorly-behaved draft might return
  const validated = store.validateScriptBody('mydraft', fakeModelBody);
  assert.strictEqual(validated.ok, false);
  assert.match(validated.reason, /ls-listing index/);
  assert.strictEqual(store.getScript('mydraft'), null, 'validateScriptBody() must never write, even on a valid-shaped name');
  const res = store.setScript('mydraft', fakeModelBody);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(store.getScript('mydraft'), null);
});

check('validation-path unit: a valid drafted body validates OK but is NOT persisted until the real write path (setScript, i.e. the approval flow) actually runs', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const fakeModelBody = 'go example.com\nsearch "socks"\n';
  const validated = store.validateScriptBody('checkout', fakeModelBody);
  assert.strictEqual(validated.ok, true);
  assert.strictEqual(store.getScript('checkout'), null, '"validate first without persisting" - design doc §4');
  const res = store.setScript('checkout', fakeModelBody);
  assert.strictEqual(res.ok, true);
  assert.notStrictEqual(store.getScript('checkout'), null);
});

check('validation-path unit: no `as <name>` yet - validateScriptBody(undefined, body) validates the BODY ALONE, skipping name checks', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  const fakeModelBody = 'go example.com\n';
  const validated = store.validateScriptBody(undefined, fakeModelBody);
  assert.strictEqual(validated.ok, true);
  assert.strictEqual(validated.steps.length, 1);
});

check('validation-path unit: a name collision with an existing ALIAS is refused at save time (checkNameAvailable/setScript, the same check the no-name follow-up prompt uses)', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setAlias('wiki', 'go en.wikipedia.org');
  const res = store.setScript('wiki', 'go example.com\n');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /already an alias name/);
});

check('validation-path unit: a name collision with an existing SCRIPT is refused the same way', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setScript('checkout', 'go example.com\n');
  const validated = store.validateScriptBody('checkout', 'go other.example.com\n');
  assert.strictEqual(validated.ok, false);
  assert.match(validated.reason, /already a script name/);
});

check('validation-path unit: a name collision with an existing MACRO is refused the same way', () => {
  const store = registry.createAliasStore(fakeStorageArea());
  store.setMacro('morning', 'go example.com && search "news"');
  const validated = store.validateScriptBody('morning', 'go example.com\n');
  assert.strictEqual(validated.ok, false);
  assert.match(validated.reason, /already a macro name/);
});

// ---- [9b] terminal.js / service-worker.js / manifest.json - static
// source-shape checks. Same documented-weaker-substitute posture as
// tests/m3_hardening.test.js's own terminal.js checks (see that file's
// header comment: terminal.js needs attachShadow/popover/elementsFromPoint,
// a much heavier DOM surface than this project's Node test harness
// supports, so dispatch-wiring and the opt-in gate are pinned structurally
// here rather than behaviorally).
console.log('\n[9b] brainstorm lane - terminal.js/manifest.json static source-shape checks (documented DOM-test-harness limitation)');

const fsForShapeChecks = require('fs');
const TERMINAL_PATH_FOR_TEACH = path.join(ROOT, 'extension', 'content', 'terminal.js');
const teachTerminalSrc = fsForShapeChecks.readFileSync(TERMINAL_PATH_FOR_TEACH, 'utf8');

check('_dispatchSegment refuses "teach" as a chain/macro/alias-expansion segment, the SAME dispatch-time check as run/script', () => {
  assert.match(
    teachTerminalSrc,
    /firstTok === 'run' \|\| firstTok === 'script' \|\| firstTok === 'teach'/,
    '_dispatchSegment must refuse teach the same way as run/script',
  );
});

check('a bare "teach" is dispatched from _submitCommand via an explicit typed-text regex (never reachable from chain/macro/alias context)', () => {
  assert.match(
    teachTerminalSrc,
    /if \(\/\^teach\(\\s\|\$\)\/i\.test\(raw\)\) \{ this\._handleTeachCommand\(raw\); return; \}/,
    '_submitCommand must gate teach behind an explicit typed-text regex, same posture as script/run',
  );
});

check('opt-in gate: _handleTeachCommand checks _brainstormEnabled and returns BEFORE the BRAINSTORM_LLM_REQUEST send - zero network calls while off', () => {
  const idx = teachTerminalSrc.indexOf('async _handleTeachCommand(raw) {');
  assert.ok(idx >= 0, '_handleTeachCommand not found');
  const nextMethodIdx = teachTerminalSrc.indexOf('\n    async _approveTeachSave()', idx);
  assert.ok(nextMethodIdx > idx, '_approveTeachSave not found after _handleTeachCommand');
  const body = teachTerminalSrc.slice(idx, nextMethodIdx);
  const gateIdx = body.indexOf('if (!this._brainstormEnabled) {');
  // The actual call site, not just any mention of the string (a comment a
  // few lines above the gate explains WHY it exists using this same phrase -
  // matching the real `await chrome.runtime.sendMessage(` invocation avoids
  // that comment giving a false-positive "call" position).
  const sendIdx = body.indexOf('await chrome.runtime.sendMessage({ type: \'BRAINSTORM_LLM_REQUEST\'');
  assert.ok(gateIdx >= 0, 'the opt-in gate check must be present in _handleTeachCommand');
  assert.ok(sendIdx >= 0, 'the BRAINSTORM_LLM_REQUEST send call must be present in _handleTeachCommand');
  assert.ok(gateIdx < sendIdx, 'the opt-in gate must run BEFORE the network call, not after');
  const gateBranch = body.slice(gateIdx, sendIdx);
  assert.match(gateBranch, /return;/, 'the opt-in gate branch must return, not fall through to the network call');
});

check('teach is present in registry.js\'s RESERVED_NAMES set - structural pin (the alias/macro-shadowing lock)', () => {
  const registrySrc = fsForShapeChecks.readFileSync(path.join(ROOT, 'extension', 'content', 'registry.js'), 'utf8');
  const idx = registrySrc.indexOf('const RESERVED_NAMES = new Set([');
  const endIdx = registrySrc.indexOf(']);', idx);
  assert.ok(idx >= 0 && endIdx > idx, 'RESERVED_NAMES definition not found');
  assert.match(registrySrc.slice(idx, endIdx), /'teach'/, 'teach must be present in RESERVED_NAMES');
});

check('manifest.json is unchanged: permissions exactly ["storage"], host_permissions exactly ["http://127.0.0.1:1238/*"] - no new host permission for the brainstorm lane (design doc §2 invariant 5, §5)', () => {
  const manifest = JSON.parse(fsForShapeChecks.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.permissions, ['storage']);
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1:1238/*']);
});

// =====================================================================
// [10] Verify-pass fix (2026-07-14 Fable, CRITICAL) - the SW-backed queue
// must hold a full script's remaining steps. The old MAX_QUEUE_SEGMENTS=5
// SILENTLY truncated a 20-step script's queue to 5 (steps 7..20 dropped
// mid-run with no error). Round-trips a 19-item queue through the REAL
// service-worker.js TS_* handlers via vm (same loading pattern as
// tests/m3_hardening.test.js's buildSwInstance).
// =====================================================================
console.log('\n[10] service-worker queue capacity - a 19-step remainder survives TS_QUEUE_SET/PEEK intact');

const fs = require('fs');
const vm = require('vm');

function buildSwInstance() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const messageListeners = [];
  const storageMap = new Map();
  sandbox.chrome = {
    runtime: { onMessage: { addListener(fn) { messageListeners.push(fn); } } },
    storage: {
      session: {
        get(key) {
          return Promise.resolve().then(() => {
            const out = {};
            const keys = Array.isArray(key) ? key : [key];
            keys.forEach((k) => { if (storageMap.has(k)) out[k] = storageMap.get(k); });
            return out;
          });
        },
        set(obj) { return Promise.resolve().then(() => { Object.keys(obj).forEach((k) => storageMap.set(k, obj[k])); }); },
        remove() { return Promise.resolve(); },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };
  sandbox.importScripts = function importScripts(...urls) {
    urls.forEach((u) => {
      const resolved = path.join(ROOT, 'extension', 'background', u);
      vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: u });
    });
  };
  sandbox.fetch = () => Promise.reject(new Error('no network in this test'));
  sandbox.AbortController = function AbortController() { this.signal = {}; this.abort = function () {}; };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'background', 'service-worker.js'), 'utf8'), sandbox, { filename: 'service-worker.js' });
  const listener = messageListeners[0];
  function send(msg, tabId) {
    return new Promise((resolve, reject) => {
      const sender = { tab: { id: tabId } };
      let responded = false;
      const keepOpen = listener(msg, sender, (resp) => { responded = true; resolve(resp); });
      if (!responded && !keepOpen) reject(new Error('listener did not respond'));
    });
  }
  return { send };
}

async function testQueueCapacity() {
  const sw = buildSwInstance();
  // a 20-step script dispatches step 1 and queues the remaining 19
  const nineteen = Array.from({ length: 19 }, (_, i) => `go example${i}.com`);
  await sw.send({ type: 'TS_QUEUE_SET', queue: nineteen, expectedOrigin: 'https://example.com' }, 1);
  const peek = await sw.send({ type: 'TS_QUEUE_PEEK' }, 1);
  assert.strictEqual(peek.ok, true);
  assert.strictEqual(peek.queue.length, 19, `queue was truncated to ${peek.queue.length} - MAX_QUEUE_SEGMENTS must be >= 19 (SCRIPT_MAX_STEPS - 1)`);
  assert.deepStrictEqual(peek.queue, nineteen);
}

async function testQueueCapConstantAgreesWithScriptCap() {
  // Structural companion: the SW source's MAX_QUEUE_SEGMENTS literal must be
  // >= SCRIPT_MAX_STEPS - 1 so this can never silently regress if either
  // side's constant moves.
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'background', 'service-worker.js'), 'utf8');
  const m = src.match(/MAX_QUEUE_SEGMENTS\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_QUEUE_SEGMENTS literal not found in service-worker.js');
  assert.ok(Number(m[1]) >= registry.SCRIPT_MAX_STEPS - 1,
    `MAX_QUEUE_SEGMENTS (${m[1]}) < SCRIPT_MAX_STEPS - 1 (${registry.SCRIPT_MAX_STEPS - 1}) - scripts would silently truncate`);
}

(async () => {
  try {
    await testQueueCapacity();
    passed += 1;
    console.log('  ok   - a 19-item queue round-trips the real SW TS_* handlers intact (no silent truncation)');
  } catch (e) {
    failed += 1;
    console.error('  FAIL - a 19-item queue round-trips the real SW TS_* handlers intact (no silent truncation)');
    console.error(`         ${e && e.message ? e.message : e}`);
  }
  try {
    await testQueueCapConstantAgreesWithScriptCap();
    passed += 1;
    console.log('  ok   - MAX_QUEUE_SEGMENTS >= SCRIPT_MAX_STEPS - 1 (structural pin, cannot silently regress)');
  } catch (e) {
    failed += 1;
    console.error('  FAIL - MAX_QUEUE_SEGMENTS >= SCRIPT_MAX_STEPS - 1 (structural pin, cannot silently regress)');
    console.error(`         ${e && e.message ? e.message : e}`);
  }

  console.log(`\nm5_scripts: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
