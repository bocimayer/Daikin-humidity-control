#!/usr/bin/env python3
"""
Print a Google-signed OIDC ID token for calling private Cloud Run (same pattern as
.github/workflows/deploy.yml smoke step).

Requires:
  - gcloud CLI authenticated (user with permission to call generateIdToken for the deploy SA)
  - Env GCP_DEPLOY_SA — e.g. daikin-deploy-sa@PROJECT.iam.gserviceaccount.com
  - Env BASE_URL — Cloud Run service URL (no trailing slash), must match EXPECTED_AUDIENCE

Usage (PowerShell, from repo root):
  $env:GCP_DEPLOY_SA='daikin-deploy-sa@your-project.iam.gserviceaccount.com'
  $env:BASE_URL='https://your-service-....a.run.app'
  python scripts/generate-cloud-run-id-token.py

Cross-references:
  - Workflow: ../.github/workflows/deploy.yml
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    sa = os.environ.get("GCP_DEPLOY_SA", "").strip()
    base = os.environ.get("BASE_URL", "").strip().rstrip("/")
    if len(sys.argv) >= 3:
        sa = sys.argv[1].strip()
        base = sys.argv[2].strip().rstrip("/")
    if not sa or not base:
        print("Usage: GCP_DEPLOY_SA and BASE_URL env vars, or: python generate-cloud-run-id-token.py <SA_EMAIL> <BASE_URL>", file=sys.stderr)
        sys.exit(1)

    gcloud = shutil.which("gcloud.cmd") or shutil.which("gcloud")
    if not gcloud:
        print("gcloud not found on PATH.", file=sys.stderr)
        sys.exit(1)

    access = subprocess.run(
        [gcloud, "auth", "print-access-token"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not access:
        print("gcloud auth print-access-token returned empty.", file=sys.stderr)
        sys.exit(1)

    enc = urllib.parse.quote(sa, safe="")
    url = f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{enc}:generateIdToken"
    body = json.dumps({"audience": base, "includeEmail": True}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {access}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req) as resp:
            token = json.load(resp)["token"]
    except urllib.error.HTTPError as e:
        print(f"generateIdToken failed HTTP {e.code}: {e.read().decode()!r}", file=sys.stderr)
        sys.exit(1)

    sys.stdout.write(token)


if __name__ == "__main__":
    main()
