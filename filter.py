import json
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"

with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
    data = json.loads(response.read().decode("utf-8"))

# data هنا List مش Dict
filtered_packages = []

for pkg in data:
    # شيل الإباحي فقط
    if not pkg.get("nsfw", False):
        filtered_packages.append(pkg)

filtered = {
    "name": "AR Safe Extensions (Mirror of Keiyoushi)",
    "source": SOURCE_URL,
    "packages": filtered_packages
}

with open("index.min.json", "w", encoding="utf-8") as f:
    json.dump(filtered, f, ensure_ascii=False, separators=(",", ":"))
