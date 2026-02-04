import json
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"

with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
    data = json.loads(response.read().decode("utf-8"))

# data = list
filtered = []

for pkg in data:
    # استبعاد الإباحي فقط
    if not pkg.get("nsfw", False):
        filtered.append(pkg)

with open("index.min.json", "w", encoding="utf-8") as f:
    json.dump(filtered, f, ensure_ascii=False, separators=(",", ":"))
