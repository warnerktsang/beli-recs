#!/usr/bin/env python3
"""Deploy ~/workspace/beli-recs to Vercel via the REST API.

Creates the `beli-recs` project if needed, then creates a production
deployment with the project files inlined. Uses the stored custom.vercel
credential via surrogate — never handles the raw token.
"""
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import (  # noqa: E402
    add_surrogate_to_request,
    read_json_response,
    read_response_body,
)

API = "https://api.vercel.com"
ALLOWED = ("api.vercel.com",)
CRED = "custom.vercel"
TEAM_ID = "team_nLH0xQvdv4obUiXd6DoUePxb"
PROJECT = "beli-recs"
ROOT = "/home/hatch/workspace/beli-recs"
FILES = ["api/recs.ts", "api/bookmark.ts", "lib/beli.ts", "package.json"]


def api(method, path, data=None, team=True):
    url = API + path
    if team:
        url += ("&" if "?" in url else "?") + "teamId=" + TEAM_ID
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(read_response_body(e).decode())
        except Exception:
            payload = {"message": str(e)}
        return e.code, payload


def main():
    # 1. project (create or reuse)
    status, proj = api("POST", "/v9/projects", {"name": PROJECT, "framework": None})
    if status in (200, 201):
        project_id = proj["id"]
        print(f"project created: {project_id}")
    elif status == 409:
        status, proj = api("GET", f"/v9/projects/{PROJECT}")
        if status != 200:
            print(json.dumps({"status": status, "data": proj}, indent=2))
            sys.exit(1)
        project_id = proj["id"]
        print(f"project exists: {project_id}")
    else:
        print(json.dumps({"status": status, "data": proj}, indent=2))
        sys.exit(1)

    # 2. deployment with inlined files
    files = []
    for rel in FILES:
        with open(f"{ROOT}/{rel}", "rb") as f:
            content = f.read()
        files.append(
            {
                "file": rel,
                "data": base64.b64encode(content).decode(),
                "encoding": "base64",
            }
        )
    status, dep = api(
        "POST",
        "/v13/deployments",
        {
            "name": PROJECT,
            "project": project_id,
            "target": "production",
            "files": files,
        },
    )
    print(json.dumps({"status": status, "data": dep}, indent=2))


if __name__ == "__main__":
    main()
