#!/usr/bin/env python3
"""Sync ~/workspace/beli-recs to GitHub (warnerktsang/beli-recs, main branch).

Uploads every tracked project file via the gh CLI (file-put). Run this after
any change to the workspace copy so GitHub stays a faithful mirror.
Excluded: state/, __pycache__/, .git state (see .gitignore).
Deploys to Vercel are separate — see deploy.py.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
GH = os.path.expanduser("~/workspace/skills/github/bin/gh")
REPO = "warnerktsang/beli-recs"
BRANCH = "main"

# Tracked files, relative to ROOT. Keep in sync with the repo contents.
TRACKED = [
    "README.md",
    ".gitignore",
    "package.json",
    "deploy.py",
    "sync_github.py",
    "beli_eats_watch.py",
    "lib/beli.ts",
    "api/recs.ts",
    "api/bookmark.ts",
]


def main():
    failures = []
    for rel in TRACKED:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            print(f"skip (missing): {rel}")
            continue
        with open(path, "rb") as f:
            content = f.read()
        proc = subprocess.run(
            [GH, "file-put", REPO, rel, "--message", f"Sync {rel}",
             "--branch", BRANCH],
            input=content, capture_output=True, timeout=60,
        )
        if proc.returncode != 0 or b'"status": 2' not in proc.stdout[:30]:
            # file-put prints {"status": 200/201, ...}; be lenient, check stderr
            try:
                import json
                status = json.loads(proc.stdout.decode()).get("status")
            except Exception:
                status = None
            if status not in (200, 201):
                failures.append(rel)
                print(f"FAIL {rel}: {proc.stderr.decode()[:200]}")
                continue
        print(f"ok: {rel}")
    if failures:
        print(f"\n{len(failures)} file(s) failed: {failures}")
        sys.exit(1)
    print("\nGitHub mirror is up to date.")


if __name__ == "__main__":
    main()
