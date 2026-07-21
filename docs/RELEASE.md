# Release runbook - lfl-terminal

This is the canonical, step-by-step path from a version bump to a staged
Chrome Web Store submission. Read docs/CWS-AUTH-SETUP.md first if the CI
release path (steps 5b/6 below) has not been set up yet; the manual path
(5a) works with no CI cloud setup at all.

Hard boundary, stated once: nothing in this repository, this CI pipeline,
or tools/cws/cws_api.py can take an extension live on the Chrome Web
Store. Every automated path here stops at a STAGED submission. Only a
human, in the Chrome Web Store Developer Dashboard, can publish a staged
submission live.

## 1. Bump the version

Edit `extension/manifest.json`, bump `"version"`. Follow semver-ish
convention (major.minor.patch); Chrome Web Store requires each submitted
version string to be strictly greater than the currently published one.

## 2. Open a PR

Normal PR flow. CI (`.github/workflows/ci.yml`) runs `fast-gates`
(`bash tests/run_fast_gates.sh`) on every push and PR; that is the
required check. `browser-smoke` also runs but is informational only, not
required - see "browser-smoke is not required" below.

## 3. Get CI green, merge to main

Do not tag a release from an unmerged branch.

## 4. Tag the release

On `main`, at the merge commit for the version bump:

```
git tag v$VERSION
git push origin v$VERSION
```

Pushing the tag triggers `.github/workflows/release.yml`.

## 5. Build the artifact

Two equivalent ways to get `dist/lfl-terminal-$VERSION.zip` and
`dist/release-manifest-$VERSION.json`:

### 5a. Locally

```
tools/build-release.sh
```

This is deterministic: it builds from `git archive` at the tagged commit,
not from a possibly-dirty working tree, so the same tag always produces
byte-identical output.

### 5b. Via the release workflow

The `build-artifact` job in `.github/workflows/release.yml` runs the same
script and uploads `dist/lfl-terminal-*.zip` and
`dist/release-manifest-*.json` as a GitHub Actions artifact.

## 6. Verify the artifact (sha256 cross-check)

Before anything gets uploaded anywhere, confirm the local build and the
CI build agree byte-for-byte:

```
sha256sum dist/lfl-terminal-$VERSION.zip
```

Compare against the sha256 recorded in `dist/release-manifest-$VERSION.json`
and against the CI-built artifact's own hash (download it from the
workflow run and hash it the same way). They must match exactly. If they
do not match, stop and investigate before uploading anything - do not
assume the CI copy is authoritative just because it is newer.

## 7. CWS staged upload

Two equivalent ways to get the artifact into the Chrome Web Store as a
draft and submitted for staged review:

### 7a. Via the release workflow (recommended once CI cloud setup is done)

The `cws-stage-upload` job in `.github/workflows/release.yml`:
- only runs when the repository variable `CWS_WIF_READY` is set to
  `"true"` (see docs/CWS-AUTH-SETUP.md) - until then it is completely
  inert, by design;
- runs under the `cws-release` GitHub Environment, which the owner
  configures with a required reviewer, so the job pauses for a human
  approval click before it authenticates to Google Cloud or touches the
  Chrome Web Store at all;
- authenticates via workload identity federation (no long-lived key ever
  touches GitHub Actions secrets);
- runs `tools/cws/cws_api.py upload --zip ...` then
  `tools/cws/cws_api.py submit`. `submit` always requests
  `{"publishType": "STAGED_PUBLISH", "blockOnWarnings": true}` - there is
  no way to make it request an immediate live publish.

### 7b. Owner-local, with a short-lived token

If CI cloud setup is not done yet, or as a manual fallback:

```
export CWS_ACCESS_TOKEN="$(gcloud auth print-access-token \
  --impersonate-service-account=SERVICE_ACCOUNT_EMAIL \
  --scopes=https://www.googleapis.com/auth/chromewebstore)"
export CWS_PUBLISHER_ID=...
export CWS_ITEM_ID=...

python3 tools/cws/cws_api.py upload --zip dist/lfl-terminal-$VERSION.zip
python3 tools/cws/cws_api.py submit
```

The token from `gcloud auth print-access-token` is short-lived (minutes
to about an hour depending on configuration); never write it to a file,
never put it in a script argument that would land in shell history in
plaintext for long, and close the shell when done.

## 8. Owner completes Dashboard-only fields

Chrome Web Store API v2 can upload a package and submit it for staged
review, but it CANNOT edit Store Listing, Privacy practices, or
Distribution/visibility metadata - those remain Dashboard-only actions in
API v2. Before (or promptly after) the staged submission clears review,
the owner must open the Chrome Web Store Developer Dashboard and verify
every field below against the repo's listing-as-code copy in
docs/CHROME-STORE-LISTING.md.

### Dashboard checklist (derived from docs/CHROME-STORE-LISTING.md)

Store Listing tab:
- [ ] Product name matches
- [ ] Summary (under 132 chars) matches
- [ ] Category is "Developer Tools"
- [ ] Language is English
- [ ] Detailed description matches the current copy in
      docs/CHROME-STORE-LISTING.md
- [ ] Store icon (128x128) matches `docs/store/icon-128-preview.png`
- [ ] Screenshots 1-3 match the current set described in the listing doc
- [ ] Optional promo tile, if used, matches

Privacy practices tab:
- [ ] Single purpose statement matches
- [ ] Permission justifications (storage, the loopback host permission,
      content scripts / all sites) match
- [ ] Data usage disclosures (no collection, no sale, no unrelated use,
      no creditworthiness use) are all still correctly unchecked/checked
      as documented
- [ ] Privacy policy URL points at the extension-specific policy page,
      not the general site privacy page

Distribution tab:
- [ ] Visibility and distribution settings match the intended launch
      state (do not accidentally widen or narrow distribution during a
      routine version bump)

None of these fields are touched by `tools/cws/cws_api.py` or by the
release workflow. They are set once and then re-verified on every release
in case the Dashboard copy has drifted from docs/CHROME-STORE-LISTING.md.

## 9. Owner performs the final staged-to-live publish

This is a manual, human-only action in the Chrome Web Store Developer
Dashboard. Nothing in this repository can do it. Review the staged
version in the Dashboard, confirm the Dashboard checklist above, and
click publish there.

## Rollback

- **Cancel a pending submission** (before it goes live): run
  `python3 tools/cws/cws_api.py cancel`. This calls the CWS
  `cancelSubmission` endpoint and stops the in-flight review; it does not
  touch anything already published.
- **Delete a git tag** (before a release artifact has been uploaded
  anywhere): `git push origin :refs/tags/v$VERSION` followed by
  `git tag -d v$VERSION` locally, then re-tag once the fix is in. Do this
  only if the tag has not yet been used for a CWS submission.
- **Never delete a published version.** Once a version has gone live on
  the Chrome Web Store, do not attempt to retract or delete it by force;
  publish a corrected new version through the normal flow instead. The
  Chrome Web Store does not support quietly erasing a version history,
  and users may already be running the published build.
