import json
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"
APK_BASE = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/apk/"

with urllib.request.urlopen(SOURCE_URL, timeout=30) as r:
    data = json.loads(r.read().decode("utf-8"))

filtered = []
for pkg in data:
    if not pkg.get("nsfw", False):
        p = dict(pkg)
        apk = p.get("apk", "")
        if apk and not apk.startswith("http"):
            p["apk"] = APK_BASE + apk
        filtered.append(p)

with open("index.min.json", "w", encoding="utf-8") as f:
    json.dump(filtered, f, ensure_ascii=False, separators=(",", ":"))
