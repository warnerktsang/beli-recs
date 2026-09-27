#!/usr/bin/env python3
"""Daily @beli_eats -> Beli auto-bookmark pipeline.

1. Pulls recent @beli_eats Instagram posts (via instagram-cli).
2. Extracts restaurant-name candidates from captions (@mentions, "📍 Name (area)",
   numbered lists).
3. Resolves each against Beli search and bookmarks confident matches via the
   beli-recs backend POST /api/bookmark (the endpoint's confidence gate skips
   ambiguous names — nothing fuzzy gets written).
4. Prints a short digest for the chat report.

State: state/beli_eats_seen.json (last processed post timestamp).
Uses the stored custom.beli-recs credential via surrogate — never raw keys.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import (  # noqa: E402
    add_surrogate_to_request,
    read_json_response,
    read_response_body,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(ROOT, "state", "beli_eats_seen.json")
BASE = "https://beli-recs.vercel.app"
ALLOWED = ("beli-recs.vercel.app",)
CRED = "custom.beli-recs"
IG_ACCOUNT_ID = "17841448724087335"  # @warnertsang
IG_HANDLE = "beli_eats"

CITY_HINTS = [
    (r"\bnyc\b|new york|manhattan|brooklyn|queens|bronx|staten island|east village|west village|soho|tribeca|chelsea|harlem|astoria|williamsburg", "New York, NY"),
    (r"\blos angeles\b|\bla\b|hollywood|santa monica|beverly hills|silver lake", "Los Angeles, CA"),
    (r"\bsan francisco\b|\bsf\b|mission district", "San Francisco, CA"),
    (r"\bchicago\b|wicker park|logan square", "Chicago, IL"),
    (r"\bmiami\b|wynwood|south beach", "Miami, FL"),
    (r"\bboston\b|cambridge|south end", "Boston, MA"),
    (r"\bwashington\b|\bdc\b|georgetown|adams morgan", "Washington, DC"),
    (r"\bphiladelphia\b|\bphilly\b", "Philadelphia, PA"),
    (r"\bseattle\b|capitol hill|ballard", "Seattle, WA"),
    (r"\baustin\b", "Austin, TX"),
    (r"\bsan juan\b|puerto rico", "San Juan, PR"),
    (r"\blondon\b|soho london|shoreditch", "London, UK"),
]

STOPWORDS = {
    "beli", "eats", "nyc", "top", "best", "new", "list", "food", "foodie",
    "restaurant", "restaurants", "spots", "guide", "part", "giveaway",
}


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def fetch_posts():
    out = subprocess.run(
        ["instagram-cli", "posts", "--account-id", IG_ACCOUNT_ID,
         "--username", IG_HANDLE, "--limit", "25"],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"instagram-cli failed: {out.stderr[:300]}")
    return json.loads(out.stdout).get("posts", [])


def guess_city(caption):
    text = (caption or "").lower()
    for pattern, city in CITY_HINTS:
        if re.search(pattern, text):
            return city
    return None


def candidates_from_caption(caption):
    text = caption or ""
    cands = []
    # "📍 Table Mercato (East Village, Manhattan)"
    for m in re.finditer(r"📍\s*([^(\n@]{2,60}?)\s*\(", text):
        cands.append(m.group(1).strip())
    # numbered lists: "1. Lucali @lucali_bk"
    for m in re.finditer(r"(?:^|\n)\s*\d+[.)]\s*([A-Z][^@\n(]{1,50}?)(?=\s*(?:@|\n|$))", text):
        cands.append(m.group(1).strip())
    # @mentions -> name variants ("lucali_bk" -> "Lucali Bk", "Lucali")
    for handle in re.findall(r"@([\w.]+)", text):
        if handle.lower() in ("beli_eats",):
            continue
        base = handle.replace(".", " ").replace("_", " ").strip()
        if not base or len(base) < 3:
            continue
        cands.append(base.title())
        first_tok = base.split()[0]
        if len(first_tok) >= 4 and first_tok.lower() != base.lower():
            cands.append(first_tok.title())
    # dedup + junk filter, preserve order
    seen, out = set(), []
    for c in cands:
        c = re.sub(r"\s+", " ", c).strip(" -–—.,!?\"'")
        key = c.lower()
        if not c or len(c) < 3 or key in seen or key in STOPWORDS:
            continue
        if len(c.split()) > 6:
            continue
        seen.add(key)
        out.append(c)
    return out


def backend_bookmark(name, city, dry_run=False):
    body = json.dumps({"name": name, "city": city, "dry_run": dry_run}).encode()
    req = urllib.request.Request(BASE + "/api/bookmark", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(read_response_body(e).decode("utf-8"))
        except Exception:
            payload = {"message": str(e)}
        return e.code, payload


def main():
    digest = []
    state = load_state()
    last_ts = state.get("last_seen_ts", "")

    try:
        posts = fetch_posts()
    except Exception as e:
        print(f"Beli Eats watch: could not fetch Instagram posts ({e}). No changes made.")
        return

    new_posts = [p for p in posts if (p.get("created_at") or "") > last_ts]
    new_posts.sort(key=lambda p: p.get("created_at") or "")

    if not new_posts:
        print("Beli Eats watch: no new posts since last check. Nothing to do.")
        return

    # quick backend health check (also surfaces the pending-credentials state)
    status, probe = backend_bookmark("__healthcheck__", None, dry_run=True)
    if status == 500 and "credentials not configured" in str(probe.get("error", "")):
        print(
            "Beli Eats watch: backend has no Beli credentials yet — bookmarking is "
            "dormant. Reply 'done' once BELI_EMAIL/BELI_PASSWORD are set on Vercel, "
            f"then I'll run the first live pass. ({len(new_posts)} new posts waiting.)"
        )
        return
    if status == 401:
        print("Beli Eats watch: backend auth failed (API key mismatch). No changes made.")
        return

    bookmarked, already, skipped = [], [], []
    seen_names = set()
    for p in new_posts:
        caption = p.get("post_caption") or ""
        city = guess_city(caption)
        for name in candidates_from_caption(caption):
            key = name.lower()
            if key in seen_names:
                continue
            seen_names.add(key)
            status, data = backend_bookmark(name, city)
            st = data.get("status") if isinstance(data, dict) else None
            if st == "bookmarked":
                b = data.get("business", {})
                label = b.get("name") or name
                if b.get("neighborhood"):
                    label += f" ({b['neighborhood']})"
                bookmarked.append(label)
            elif st == "already_bookmarked":
                already.append(name)
            elif st in ("ambiguous", "no_results"):
                skipped.append(name)
            else:
                skipped.append(f"{name} [error: {data.get('error', status) if isinstance(data, dict) else status}]")

    # advance watermark to newest post seen
    newest = max(p.get("created_at") or "" for p in new_posts)
    state["last_seen_ts"] = newest
    save_state(state)

    lines = [f"Beli Eats watch: checked {len(new_posts)} new post(s)."]
    if bookmarked:
        lines.append("Bookmarked: " + "; ".join(bookmarked))
    if already:
        lines.append(f"Already bookmarked ({len(already)}): " + "; ".join(already[:8]))
    if skipped:
        lines.append(f"Skipped as ambiguous ({len(skipped)}): " + "; ".join(skipped[:8]))
    if not (bookmarked or already or skipped):
        lines.append("No restaurant names extracted.")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
