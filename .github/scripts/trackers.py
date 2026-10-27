"""Write trackers.json: every Airtable base, table and view the token can see.

Reads only the SHAPE of each base through the metadata API. It never asks for
a single record, so the token only ever needs schema.bases:read. A table named
"Student Stuff" shows up here as those two words and nothing else.
"""
import json, os, pathlib, sys, urllib.request, urllib.error, datetime

TOKEN = os.environ.get("AIRTABLE_TOKEN", "").strip()
if not TOKEN:
    sys.exit("AIRTABLE_TOKEN is not set. Add it as a repository secret.")

# Optional: a comma separated list of base ids. Leave unset to list them all.
ONLY = [b.strip() for b in os.environ.get("AIRTABLE_BASES", "").split(",") if b.strip()]

API = "https://api.airtable.com/v0/meta"


def get(path):
    req = urllib.request.Request(API + path, headers={
        "Authorization": "Bearer " + TOKEN,
        "User-Agent": "football-video-ops-tracker-links",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        sys.exit("Airtable said %s for %s\n%s" % (e.code, path, body))


def list_bases():
    if ONLY:
        return [{"id": b, "name": b} for b in ONLY]
    out, offset = [], None
    while True:
        page = get("/bases" + ("?offset=" + offset if offset else ""))
        out.extend(page.get("bases", []))
        offset = page.get("offset")
        if not offset:
            break
    return out


bases = []
for b in list_bases():
    schema = get("/bases/%s/tables" % b["id"])
    tables = []
    for t in schema.get("tables", []):
        views = [{"id": v["id"], "name": v.get("name", ""), "type": v.get("type", "")}
                 for v in t.get("views", [])]
        tables.append({"id": t["id"], "name": t.get("name", ""),
                       "desc": t.get("description", "") or "",
                       "fields": len(t.get("fields", [])),
                       "views": views})
    bases.append({"id": b["id"], "name": b.get("name", b["id"]), "tables": tables})

bases.sort(key=lambda x: x["name"].lower())
out = {"built": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
       "bases": bases}

dest = pathlib.Path("trackers.json")
new = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
old = dest.read_text(encoding="utf-8") if dest.exists() else ""
# ignore a changed timestamp when nothing else moved
def strip_built(s):
    try:
        d = json.loads(s); d.pop("built", None); return json.dumps(d, sort_keys=True)
    except Exception:
        return s
if strip_built(old) == strip_built(new):
    print("no change")
else:
    dest.write_text(new, encoding="utf-8")
    print("wrote %d base(s), %d table(s)"
          % (len(bases), sum(len(b["tables"]) for b in bases)))
