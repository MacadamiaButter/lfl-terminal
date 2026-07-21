#!/usr/bin/env python3
"""tools/cws/cws_api.py - thin Chrome Web Store API v2 client, stdlib only.

Talks directly to the public REST v2 endpoints under
https://chromewebstore.googleapis.com/ (upload, fetchStatus, publish,
cancelSubmission). No third-party HTTP library, no Google API client
library: urllib.request, json, os, sys, argparse only, so this script has
zero supply-chain surface beyond the Python interpreter itself.

Configuration is env-only, never a flag and never a file on disk:
  CWS_PUBLISHER_ID    the publisher resource name segment, e.g. "acme-inc"
  CWS_ITEM_ID         the extension's item id
  CWS_ACCESS_TOKEN    a short-lived OAuth2 bearer token (minutes-scale
                      lifetime, e.g. from `gcloud auth print-access-token
                      --impersonate-service-account=...` or a workload
                      identity federation exchange in CI). This script
                      never reads a key file, never accepts a token as a
                      command-line argument (that would land in shell
                      history and process listings), and never prints the
                      token, including inside any echoed error body.

Subcommands:
  upload  --zip PATH   upload a packed .zip as the item's new draft package
  status                fetch the current publish/review status of the item
  submit                submit the current draft for staged review; ALWAYS
                         sends {"publishType": "STAGED_PUBLISH",
                         "blockOnWarnings": true} - there is no flag to
                         request DEFAULT_PUBLISH (immediate live publish)
                         from this tool, on purpose.
  cancel                cancel the item's current active submission

Every subcommand accepts --dry-run, which prints the exact HTTP method,
URL, and (auth-header-redacted) request body it would send, then exits
without making any network call.

Design boundary, stated once and enforced by the code above: THIS TOOL
CANNOT PRODUCE A PRODUCTION PUBLISH. `submit` only ever requests a staged
review (STAGED_PUBLISH). Taking a staged, human-approved item live on the
Chrome Web Store is a separate, manual action a human takes in the Chrome
Web Store Developer Dashboard - this script has no code path that can do
it for them.
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

API_BASE = "https://chromewebstore.googleapis.com/v2"
UPLOAD_BASE = "https://chromewebstore.googleapis.com/upload/v2"

# Hardcoded, non-configurable: the only publish request body this tool can
# ever send. There is deliberately no flag or env var that can change
# publishType to DEFAULT_PUBLISH.
SUBMIT_BODY = {"publishType": "STAGED_PUBLISH", "blockOnWarnings": True}


def _redact(text):
    """Best-effort scrub of a bearer token from any string before it is
    printed (error bodies, dry-run previews, etc). Matches the literal
    token value if we still have it in scope, plus the generic
    'Authorization: Bearer ...' header shape as a fallback so a token
    reflected back by the server (or logged upstream) does not leak
    either."""
    token = os.environ.get("CWS_ACCESS_TOKEN", "")
    if token:
        text = text.replace(token, "[REDACTED]")
    import re
    text = re.sub(r"(?i)(authorization\s*:\s*bearer\s+)\S+", r"\1[REDACTED]", text)
    return text


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        print(f"error: required environment variable {name} is not set", file=sys.stderr)
        sys.exit(2)
    return value


def _item_name(publisher_id, item_id):
    return f"publishers/{publisher_id}/items/{item_id}"


def _request(method, url, data=None, content_type=None, dry_run=False, token=None):
    """Perform (or, if dry_run, describe) a single HTTP request. Returns
    the decoded JSON response body on success (or {} for an empty body),
    exits non-zero with the (redacted) error body on failure."""
    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    display_headers = dict(headers)
    display_headers["Authorization"] = "Bearer [REDACTED]"

    if dry_run:
        print(f"[dry-run] {method} {url}")
        for key, value in display_headers.items():
            print(f"[dry-run] header: {key}: {value}")
        if data:
            if content_type == "application/zip":
                print(f"[dry-run] body: <{len(data)} bytes of zip data>")
            elif content_type == "application/json":
                print(f"[dry-run] body: {json.dumps(json.loads(data), indent=2)}")
            else:
                print(f"[dry-run] body: <{len(data)} bytes>")
        else:
            print("[dry-run] body: <empty>")
        return {}

    headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"error: {method} {url} failed with HTTP {exc.code}", file=sys.stderr)
        print(_redact(body), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"error: {method} {url} failed: {_redact(str(exc))}", file=sys.stderr)
        sys.exit(1)


def cmd_upload(args):
    publisher_id = _require_env("CWS_PUBLISHER_ID")
    item_id = _require_env("CWS_ITEM_ID")
    token = None if args.dry_run else _require_env("CWS_ACCESS_TOKEN")

    if not os.path.isfile(args.zip):
        print(f"error: --zip path does not exist: {args.zip}", file=sys.stderr)
        sys.exit(2)

    name = _item_name(publisher_id, item_id)
    url = f"{UPLOAD_BASE}/{name}:upload"

    if args.dry_run:
        data = b""
        with open(args.zip, "rb") as fh:
            data = fh.read()
        result = _request("POST", url, data=data, content_type="application/zip", dry_run=True)
    else:
        with open(args.zip, "rb") as fh:
            data = fh.read()
        result = _request("POST", url, data=data, content_type="application/zip", token=token)
        print(json.dumps(result, indent=2))
    return result


def cmd_status(args):
    publisher_id = _require_env("CWS_PUBLISHER_ID")
    item_id = _require_env("CWS_ITEM_ID")
    token = None if args.dry_run else _require_env("CWS_ACCESS_TOKEN")

    name = _item_name(publisher_id, item_id)
    url = f"{API_BASE}/{name}:fetchStatus"

    result = _request("GET", url, dry_run=args.dry_run, token=token)
    if not args.dry_run:
        print(json.dumps(result, indent=2))
    return result


def cmd_submit(args):
    publisher_id = _require_env("CWS_PUBLISHER_ID")
    item_id = _require_env("CWS_ITEM_ID")
    token = None if args.dry_run else _require_env("CWS_ACCESS_TOKEN")

    name = _item_name(publisher_id, item_id)
    url = f"{API_BASE}/{name}:publish"
    body = json.dumps(SUBMIT_BODY).encode("utf-8")

    result = _request("POST", url, data=body, content_type="application/json", dry_run=args.dry_run, token=token)
    if not args.dry_run:
        print(json.dumps(result, indent=2))
    return result


def cmd_cancel(args):
    publisher_id = _require_env("CWS_PUBLISHER_ID")
    item_id = _require_env("CWS_ITEM_ID")
    token = None if args.dry_run else _require_env("CWS_ACCESS_TOKEN")

    name = _item_name(publisher_id, item_id)
    url = f"{API_BASE}/{name}:cancelSubmission"

    result = _request("POST", url, data=b"", content_type=None, dry_run=args.dry_run, token=token)
    if not args.dry_run:
        print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(
        prog="cws_api.py",
        description="Chrome Web Store API v2 client (stdlib only). "
        "Cannot production-publish by design: `submit` only ever requests "
        "a STAGED_PUBLISH review. Final publication is a human action in "
        "the Chrome Web Store Developer Dashboard.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_upload = sub.add_parser("upload", help="upload a packed .zip as the item's new draft package")
    p_upload.add_argument("--zip", required=True, help="path to the built extension .zip")
    p_upload.add_argument("--dry-run", action="store_true")
    p_upload.set_defaults(func=cmd_upload)

    p_status = sub.add_parser("status", help="fetch the item's current publish/review status")
    p_status.add_argument("--dry-run", action="store_true")
    p_status.set_defaults(func=cmd_status)

    p_submit = sub.add_parser("submit", help="submit the current draft for staged review (STAGED_PUBLISH only)")
    p_submit.add_argument("--dry-run", action="store_true")
    p_submit.set_defaults(func=cmd_submit)

    p_cancel = sub.add_parser("cancel", help="cancel the item's current active submission")
    p_cancel.add_argument("--dry-run", action="store_true")
    p_cancel.set_defaults(func=cmd_cancel)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
