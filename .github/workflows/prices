#!/usr/bin/env python3
"""Refresh the Amazon and B&H prices on the Football Video Ops purchase list.

Reads every line in the Supabase "buy" table that has a product link saved for
amazon or bh, fetches that page, pulls a price out of it, and writes the number
back through set_buy_price with src="auto".

Honest about what this can and cannot do. Retailers do not want a script
reading their prices, and both of these will sometimes serve a page with no
price in it at all. When that happens the job leaves whatever number is already
on the line alone, says so in the run summary, and tries again next time. It
never writes a blank over a price somebody typed in by hand.

Needs one secret: FVO_PASSCODE, the staff passcode. The Supabase URL and the
public key are read out of config.js in the repo, the same pair the site uses.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
VENDORS = ("amazon", "bh")
TIMEOUT = 25


# ------------------------------------------------------------------ config
def read_config():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not (url and key):
        try:
            with open("config.js", encoding="utf-8") as f:
                src = f.read()
        except OSError:
            src = ""
        m = re.search(r'url\s*:\s*["\']([^"\']+)["\']', src)
        if m and not url:
            url = m.group(1)
        m = re.search(r'anonKey\s*:\s*["\']([^"\']+)["\']', src)
        if m and not key:
            key = m.group(1)
    code = os.environ.get("FVO_PASSCODE", "")
    if not (url and key and code):
        sys.exit("Missing SUPABASE_URL / SUPABASE_ANON_KEY (config.js) or FVO_PASSCODE.")
    return url.rstrip("/"), key, code


def sb(url, key, path, method="GET", body=None):
    req = urllib.request.Request(
        url + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": key,
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else None


# ------------------------------------------------------------------ scraping
def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


def walk_ld(node, out):
    """Collect every offers.price we can see in a JSON-LD blob."""
    if isinstance(node, list):
        for x in node:
            walk_ld(x, out)
        return
    if not isinstance(node, dict):
        return
    offers = node.get("offers")
    if offers is not None:
        walk_ld(offers, out)
    for field in ("price", "lowPrice"):
        v = node.get(field)
        if isinstance(v, (int, float, str)):
            try:
                n = float(str(v).replace(",", "").replace("$", ""))
                if n > 0:
                    out.append(n)
            except ValueError:
                pass
    for v in node.values():
        if isinstance(v, (dict, list)):
            walk_ld(v, out)


def price_from(html):
    """Structured data first, meta tags second. Never guess off loose text:
    a wrong price here is worse than no price."""
    found = []
    for block in re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            html, re.S | re.I):
        try:
            walk_ld(json.loads(block.strip()), found)
        except (ValueError, TypeError):
            continue
    if found:
        return min(found), "json-ld"

    for pat in (r'<meta[^>]+property=["\'](?:og:price:amount|product:price:amount)["\'][^>]+content=["\']([\d.,]+)["\']',
                r'<meta[^>]+content=["\']([\d.,]+)["\'][^>]+property=["\'](?:og:price:amount|product:price:amount)["\']',
                r'<meta[^>]+itemprop=["\']price["\'][^>]+content=["\']([\d.,]+)["\']'):
        m = re.search(pat, html, re.I)
        if m:
            try:
                n = float(m.group(1).replace(",", ""))
                if n > 0:
                    return n, "meta"
            except ValueError:
                pass
    return None, "none"


# ------------------------------------------------------------------ run
def main():
    url, key, code = read_config()
    rest = url + "/rest/v1"
    rows = sb(rest, key, "/buy?select=id,what,status,prices&order=id") or []

    jobs = []
    for row in rows:
        if row.get("status") == "dropped":
            continue
        prices = row.get("prices") or {}
        for v in VENDORS:
            link = (prices.get(v) or {}).get("url") or ""
            if link.startswith("http"):
                jobs.append((row["id"], row["what"], v, link, (prices.get(v) or {}).get("price")))

    lines = ["| Item | Vendor | Was | Now | |", "| --- | --- | --- | --- | --- |"]
    changed = fails = same = 0

    for i, (rid, what, vendor, link, was) in enumerate(jobs):
        if i:
            time.sleep(4)                      # be a polite visitor
        note, now = "", None
        try:
            now, how = price_from(fetch(link))
            if now is None:
                note = "no price on the page"
        except urllib.error.HTTPError as e:
            note = "blocked (HTTP %s)" % e.code
        except Exception as e:                 # noqa: BLE001 - log and carry on
            note = type(e).__name__

        if now is None:
            fails += 1
            lines.append("| %s | %s | %s | kept | %s |" % (
                what[:40], vendor, "-" if was is None else "$%.2f" % float(was), note))
            continue

        if was is not None and abs(float(was) - now) < 0.005:
            same += 1
            lines.append("| %s | %s | $%.2f | unchanged | %s |" % (what[:40], vendor, now, how))
            continue

        try:
            sb(rest, key, "/rpc/set_buy_price", "POST", {
                "p_code": code, "p_id": rid, "p_vendor": vendor,
                "p_price": round(now, 2), "p_url": link, "p_ref": "", "p_src": "auto"})
            changed += 1
            lines.append("| %s | %s | %s | $%.2f | %s |" % (
                what[:40], vendor, "-" if was is None else "$%.2f" % float(was), now, how))
        except Exception as e:                 # noqa: BLE001
            fails += 1
            lines.append("| %s | %s | - | write failed | %s |" % (what[:40], vendor, type(e).__name__))

    head = "## Price refresh\n\n%d link%s checked, %d updated, %d unchanged, %d could not be read.\n\n" % (
        len(jobs), "" if len(jobs) == 1 else "s", changed, same, fails)
    body = head + ("\n".join(lines) if jobs else
                   "No product links saved yet. Paste an Amazon or B&H product page onto a line "
                   "in the purchase list and it will start showing up here.\n")

    print(body)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(body + "\n")


if __name__ == "__main__":
    main()
