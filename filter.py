import json
import requests

SOURCE_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"

data = requests.get(SOURCE_URL, timeout=30).json()

filtered = {
    "name": "AR Safe Extensions (Mirror of Keiyoushi)",
    "source": SOURCE_URL,
    "packages": []
}

for pkg in data.get("packages", []):
    # Keep everything except NSFW
    if not pkg.get("nsfw", False):
        filtered["packages"].append(pkg)

with open("index.min.json", "w", encoding="utf-8") as f:
    json.dump(filtered, f, ensure_ascii=False, separators=(",", ":"))
