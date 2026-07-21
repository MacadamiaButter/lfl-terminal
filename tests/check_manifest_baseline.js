#!/usr/bin/env node
/**
 * tests/check_manifest_baseline.js - permission-drift gate.
 *
 * Compares extension/manifest.json against the committed, human-reviewed
 * baseline in tests/manifest-baseline.json. Any change to the permission
 * surface (permissions, host_permissions, optional_permissions,
 * content_scripts matches) or the appearance of a new permission-bearing
 * manifest key (optional_host_permissions, a broad web_accessible_resources
 * entry, etc.) is a FAIL - not a warning. A real baseline change requires
 * explicit human review and updating tests/manifest-baseline.json in the
 * SAME PR as the manifest change; this gate never auto-approves drift.
 *
 * Node stdlib only, no dependencies (matches the rest of this repo).
 *
 * argv[1] optionally overrides the manifest path under test, so this gate
 * itself is testable against a scratch file without ever touching the real
 * extension/manifest.json. argv[2] optionally overrides the baseline path
 * the same way.
 *
 * Run: node tests/check_manifest_baseline.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = process.argv[2] || path.join(ROOT, 'extension', 'manifest.json');
const BASELINE_PATH = process.argv[3] || path.join(__dirname, 'manifest-baseline.json');

// Manifest keys that can widen the extension's capability surface. If any
// of these show up in the manifest under test, they must be accounted for
// by the baseline explicitly (permissions / host_permissions /
// optional_permissions already are). Anything else in this list appearing
// at all is an automatic FAIL - the baseline has no slot for it, so there
// is nothing to compare against and no way it could have been reviewed.
const OTHER_PERMISSION_BEARING_KEYS = [
  'optional_host_permissions',
  'web_accessible_resources',
  'externally_connectable',
  'content_security_policy',
  'sandbox',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`could not read ${label} at ${filePath}: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${label} at ${filePath} is not valid JSON: ${err.message}`);
    return null;
  }
}

function asSet(arr) {
  return new Set(Array.isArray(arr) ? arr : []);
}

function setDiff(labelA, setA, labelB, setB) {
  const onlyInA = [...setA].filter((x) => !setB.has(x));
  const onlyInB = [...setB].filter((x) => !setA.has(x));
  const diffs = [];
  if (onlyInA.length > 0) {
    diffs.push(`  present in ${labelA} but not ${labelB}: ${JSON.stringify(onlyInA)}`);
  }
  if (onlyInB.length > 0) {
    diffs.push(`  present in ${labelB} but not ${labelA}: ${JSON.stringify(onlyInB)}`);
  }
  return diffs;
}

function main() {
  const manifest = readJson(MANIFEST_PATH, 'manifest');
  const baseline = readJson(BASELINE_PATH, 'baseline');
  if (manifest === null || baseline === null) {
    return;
  }

  const diffs = [];

  diffs.push(
    ...setDiff(
      'manifest.permissions',
      asSet(manifest.permissions),
      'baseline.permissions',
      asSet(baseline.permissions)
    )
  );
  diffs.push(
    ...setDiff(
      'manifest.host_permissions',
      asSet(manifest.host_permissions),
      'baseline.host_permissions',
      asSet(baseline.host_permissions)
    )
  );
  diffs.push(
    ...setDiff(
      'manifest.optional_permissions',
      asSet(manifest.optional_permissions),
      'baseline.optional_permissions',
      asSet(baseline.optional_permissions)
    )
  );

  const manifestScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const manifestMatches = new Set();
  for (const entry of manifestScripts) {
    for (const m of Array.isArray(entry.matches) ? entry.matches : []) {
      manifestMatches.add(m);
    }
  }
  diffs.push(
    ...setDiff(
      'manifest content_scripts matches',
      manifestMatches,
      'baseline.content_scripts_matches',
      asSet(baseline.content_scripts_matches)
    )
  );

  for (const key of OTHER_PERMISSION_BEARING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      diffs.push(`  new permission-bearing key present in manifest: "${key}" = ${JSON.stringify(manifest[key])}`);
    }
  }

  if (diffs.length > 0) {
    fail(
      'manifest permission surface differs from the approved baseline:\n' +
        diffs.join('\n') +
        '\n\nA baseline change requires explicit human review and updating ' +
        'tests/manifest-baseline.json in the same PR as the manifest change.'
    );
    return;
  }

  console.log('PASS: manifest permission surface matches the approved baseline.');
}

main();
