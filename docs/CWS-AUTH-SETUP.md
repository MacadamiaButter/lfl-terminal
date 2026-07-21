# Chrome Web Store CI auth setup - workload identity federation

This document is the one-time (or rarely-repeated) setup that lets the
`cws-stage-upload` job in `.github/workflows/release.yml` authenticate to
the Chrome Web Store API without ever storing a long-lived Google Cloud
service account key in GitHub Actions secrets. Until this setup is
complete, that job stays inert - it is gated on the repository variable
`CWS_WIF_READY` being exactly the string `"true"`, and defaults to not
running at all.

All project IDs, numbers, and identifiers below are placeholders. Replace
them with real values as you go; do not commit real values into this file.

No permanent JSON service account key should ever exist for this
integration, and none should ever be stored in a GitHub Actions secret.
If you find one, delete it and rotate.

Steps marked **[OWNER ONLY]** require Google Cloud project-owner or
organization-admin rights, or the CWS Developer Dashboard account owner
role, and cannot be delegated to an agent or automated.

## 1. Google Cloud project [OWNER ONLY]

1. Create or choose a dedicated GCP project for this integration, e.g.
   `PROJECT_ID` (placeholder - use your own project id).
2. Enable the Chrome Web Store API plus the three APIs workload identity
   federation itself depends on:
   ```
   gcloud services enable chromewebstore.googleapis.com iam.googleapis.com \
     iamcredentials.googleapis.com sts.googleapis.com --project=PROJECT_ID
   ```

## 2. Dedicated service account [OWNER ONLY]

Create a service account with **no IAM roles granted on the GCP project
itself**. Its only purpose is to be impersonated via workload identity
federation and to be recognized by the Chrome Web Store Developer
Dashboard; it does not need any GCP resource permissions.

```
gcloud iam service-accounts create cws-release-ci \
  --project=PROJECT_ID \
  --display-name="CWS release CI (no GCP roles, CWS-Dashboard-linked only)"
```

Resulting email will look like
`cws-release-ci@PROJECT_ID.iam.gserviceaccount.com`.

## 3. Attach the service account in the CWS Developer Dashboard [OWNER ONLY]

In the Chrome Web Store Developer Dashboard, under the publisher's
Account tab, add this service account as an API-authorized account for
the publisher.

Verified limit to plan around: a Chrome Web Store publisher account can
have only **one** service account attached for API access at a time.
Attaching a new one replaces the old one - do not attach a second service
account for some other automation without first confirming this still
holds and planning around it.

## 4. Create a workload identity pool and GitHub OIDC provider [OWNER ONLY]

```
gcloud iam workload-identity-pools create github-pool \
  --project=PROJECT_ID \
  --location=global \
  --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project=PROJECT_ID \
  --location=global \
  --workload-identity-pool=github-pool \
  --display-name="GitHub OIDC provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id" \
  --attribute-condition="assertion.repository_id == 'REPO_ID_NUMBER' && assertion.sub == 'repo:OWNER@OWNER_ID_NUMBER/REPO@REPO_ID_NUMBER:environment:cws-release'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

Notes on the attribute mapping and condition above:

- Map and condition on **numeric** `repository_id` and
  `repository_owner_id` claims, not the string `repository`/`repository_owner`
  claims. Numeric IDs cannot be reused after a rename or a repo/account
  deletion the way name strings can, which closes the classic
  cybersquat-after-rename or cybersquat-after-deletion hole in OIDC trust
  configuration. Look up the real numeric repository id with
  `gh api repos/OWNER/REPO --jq .id` and the owner id with
  `gh api users/OWNER --jq .id` (or `gh api orgs/OWNER --jq .id` for an
  org), and substitute those numbers for `REPO_ID_NUMBER` above.
- The `sub` format above assumes the repository's **immutable OIDC
  subject claims** toggle (step 6) is enabled: with it on, GitHub issues
  `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ENV` instead of the
  classic `repo:OWNER/REPO:environment:ENV`. Enable the toggle FIRST,
  then set this condition to the immutable format; with the toggle off,
  use the classic format instead. A mismatch fails closed (auth denied).
- The attribute condition binds on **both** `repository_id` and the full
  `sub` claim including `environment:cws-release`. Binding on the
  environment claim means a workflow run outside the `cws-release`
  GitHub Environment (see step 6) cannot mint a token from this provider
  even if it runs from the correct repository - a compromised or
  careless workflow change elsewhere in the repo still cannot reach this
  provider without also going through the environment's required
  reviewer gate.

## 5. Grant the service account the two roles the federation needs [OWNER ONLY]

```
gcloud iam service-accounts add-iam-policy-binding \
  cws-release-ci@PROJECT_ID.iam.gserviceaccount.com \
  --project=PROJECT_ID \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository_id/REPO_ID_NUMBER"

gcloud iam service-accounts add-iam-policy-binding \
  cws-release-ci@PROJECT_ID.iam.gserviceaccount.com \
  --project=PROJECT_ID \
  --role=roles/iam.serviceAccountTokenCreator \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository_id/REPO_ID_NUMBER"
```

`roles/iam.workloadIdentityUser` lets the federated identity present
itself as this service account. `roles/iam.serviceAccountTokenCreator` is
what actually lets the CI job mint a short-lived access token via
impersonation (`gcloud auth print-access-token
--impersonate-service-account=...` follows the same pattern locally).
Grant both scoped to the `principalSet` above, never to `allUsers` or a
broader principal.

## 6. GitHub side setup [OWNER ONLY, except the vars which can be set by whoever has repo admin]

1. Create a GitHub Environment named exactly `cws-release` (Settings ->
   Environments). Add a **required reviewer** - the owner, so every
   `cws-stage-upload` run pauses for a human approval click before it can
   authenticate to Google Cloud at all.
2. Add these repository (or environment) **variables** (Settings ->
   Secrets and variables -> Actions -> Variables tab - NOT the Secrets
   tab; none of these values are sensitive on their own, and putting them
   in Variables instead of Secrets keeps them visible/auditable in PR
   checks without giving up any real security, since the actual trust
   boundary is the WIF attribute condition and the environment reviewer
   gate, not secrecy of these strings):
   - `CWS_WIF_PROVIDER` - full resource name of the provider from step 4,
     e.g.
     `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider`
   - `CWS_SERVICE_ACCOUNT` - `cws-release-ci@PROJECT_ID.iam.gserviceaccount.com`
   - `CWS_PUBLISHER_ID` - the CWS publisher id
   - `CWS_ITEM_ID` - the extension's item id
   - `CWS_WIF_READY` - set to the literal string `true` only once every
     step above is verified working end to end (step 7). Leave it unset
     or `false` until then; the `cws-stage-upload` job's `if:` condition
     treats anything else as "not ready" and simply skips the job.
3. **Enable the repository's immutable OIDC subject-claims toggle.**
   GitHub introduced this as an opt-in hardening feature in April 2026;
   repositories created before 2026-07-15 (this one included, since it
   predates that date) must explicitly opt in under Settings -> Actions
   -> General, it is not on by default for pre-existing repos. This locks
   the set of claims GitHub will assert in the OIDC token so a later
   workflow change cannot silently widen what `sub`/`repository_id`
   values a token can carry.
4. Confirm no long-lived service account key exists anywhere in this
   repository's secrets. `CWS_ACCESS_TOKEN` should never appear as a
   GitHub Actions secret - the workflow mints it fresh, in-job, via the
   `google-github-actions/auth` step's `token_format: access_token`
   output (auto-masked in logs), and it lives only in that job's process
   environment for the duration of the run.

## 7. Prove the chain with a staged, non-production test

Before setting `CWS_WIF_READY` to `true` for real releases:

1. Manually trigger `.github/workflows/release.yml` via
   `workflow_dispatch` against a throwaway or pre-release tag.
2. Temporarily set `CWS_WIF_READY=true` for that one test run.
3. Confirm in the run logs that `cws-stage-upload` paused for the
   required reviewer approval, then authenticated, then ran
   `tools/cws/cws_api.py upload` successfully (a real upload of a
   throwaway build is fine here - it only creates a new draft package,
   which is safe to overwrite later). Note the workflow job runs its
   `submit` step right after `upload`; for a pure upload-only first test,
   temporarily comment out the submit step on a branch, or let it run and
   immediately `tools/cws/cws_api.py cancel` the staged submission.
4. Confirm in the Chrome Web Store Developer Dashboard that the draft
   package appears as expected, then either leave it as a draft or run
   `tools/cws/cws_api.py cancel` if a submission was accidentally started.
5. Only after this test passes end to end, set `CWS_WIF_READY=true`
   for real and treat the pipeline as trusted for actual releases.

## What this setup can never do

Nothing in this setup grants any GitHub Actions job the ability to
production-publish an extension. `tools/cws/cws_api.py submit` always
requests `STAGED_PUBLISH`; there is no credential, role, or flag anywhere
in this chain that changes that. Taking a staged submission live remains
a manual Chrome Web Store Developer Dashboard action performed by a
human, every single release.
