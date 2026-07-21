#!/usr/bin/env node
/**
 * tests/check_store_assets.js - store/icon asset presence + exact-dimension
 * gate.
 *
 * The Chrome Web Store listing and the extension manifest both depend on a
 * fixed set of PNG assets at exact pixel dimensions. This gate parses just
 * enough of the PNG format (the 8-byte signature, then the IHDR chunk's
 * width/height at fixed offsets) to verify each required file exists and is
 * exactly the size its filename promises, with no image-library dependency
 * (this repo is dependency-free by design: Node stdlib only).
 *
 * PNG layout relied on here (fixed, spec-guaranteed for every valid PNG):
 *   bytes 0-7   : the 8-byte PNG signature
 *   bytes 8-11  : IHDR chunk length (always 13, unchecked here)
 *   bytes 12-15 : ASCII "IHDR"
 *   bytes 16-19 : width,  big-endian uint32
 *   bytes 20-23 : height, big-endian uint32
 *
 * Run: node tests/check_store_assets.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const REQUIRED_ASSETS = [
  { file: path.join(ROOT, 'docs', 'store', 'promo-marquee-1400x560.png'), width: 1400, height: 560 },
  { file: path.join(ROOT, 'docs', 'store', 'promo-small-440x280.png'), width: 440, height: 280 },
  { file: path.join(ROOT, 'docs', 'store', 'screenshot-1-1280x800.png'), width: 1280, height: 800 },
  { file: path.join(ROOT, 'docs', 'store', 'screenshot-2-1280x800.png'), width: 1280, height: 800 },
  { file: path.join(ROOT, 'docs', 'store', 'screenshot-3-1280x800.png'), width: 1280, height: 800 },
  { file: path.join(ROOT, 'extension', 'icons', 'icon16.png'), width: 16, height: 16 },
  { file: path.join(ROOT, 'extension', 'icons', 'icon48.png'), width: 48, height: 48 },
  { file: path.join(ROOT, 'extension', 'icons', 'icon128.png'), width: 128, height: 128 },
];

function readPngDimensions(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, header, 0, 24, 0);
    if (bytesRead < 24) {
      return { error: `file is only ${bytesRead} bytes, too short to be a PNG` };
    }
    if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { error: 'missing PNG signature (not a valid PNG file)' };
    }
    if (header.toString('ascii', 12, 16) !== 'IHDR') {
      return { error: 'first chunk is not IHDR (unexpected PNG structure)' };
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return { width, height };
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  const problems = [];

  for (const asset of REQUIRED_ASSETS) {
    const rel = path.relative(ROOT, asset.file);
    if (!fs.existsSync(asset.file)) {
      problems.push(`MISSING: ${rel}`);
      continue;
    }
    const dims = readPngDimensions(asset.file);
    if (dims.error) {
      problems.push(`INVALID: ${rel}: ${dims.error}`);
      continue;
    }
    if (dims.width !== asset.width || dims.height !== asset.height) {
      problems.push(
        `WRONG SIZE: ${rel}: expected ${asset.width}x${asset.height}, found ${dims.width}x${dims.height}`
      );
    }
  }

  if (problems.length > 0) {
    console.error('FAIL: store/icon asset check found problem(s):');
    for (const p of problems) {
      console.error(`  ${p}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: all ${REQUIRED_ASSETS.length} store/icon assets present at exact required dimensions.`);
}

main();
