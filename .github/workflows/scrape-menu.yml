#!/usr/bin/env python3
"""
Scrapes today's menu from https://menu.foosto.com/ and writes it to
menu-data.json in the repo root, in the shape index.html expects.

Run manually from the repo root:
    python3 scripts/scrape_menu.py

Run automatically: see .github/workflows/scrape-menu.yml (daily cron +
a manual "Run workflow" button on GitHub).

Safety rule: if the fetch fails, or the page comes back looking broken
(way fewer chefs/dishes than a normal day), the script exits with a
non-zero status WITHOUT touching menu-data.json. The site then just
keeps showing yesterday's last-known-good menu instead of going blank
or showing garbage -- a stale menu is much less bad than a broken page.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

SOURCE_URL = "https://menu.foosto.com/"
OUTPUT_PATH = "menu-data.json"
ACCENTS = ["gold", "green", "brick"]  # cycled per chef, matches the page's existing look
MIN_CHEFS_EXPECTED = 5  # sanity floor; a normal day has 10+


class HeadingExtractor(HTMLParser):
    """Walks the page and records (level, text) for every h1/h2/h6 tag in
    document order. On menu.foosto.com these map exactly to:
      h1 -> "Chef: <name>"
      h2 -> dish description
      h6 -> "Price : x" / "Menu Code: x" / "Available: x"
    This only depends on that heading structure, not on any CSS class
    names, so it should keep working even if Foosto restyles the page.
    """

    def __init__(self):
        super().__init__()
        self.headings = []
        self._level = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2", "h6"):
            self._level = tag
            self._buf = []

    def handle_endtag(self, tag):
        if tag == self._level:
            text = " ".join("".join(self._buf).split())
            if text:
                self.headings.append((tag, text))
            self._level = None
            self._buf = []

    def handle_data(self, data):
        if self._level is not None:
            self._buf.append(data)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; FoostoMenuBot/1.0)"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_menu(html):
    parser = HeadingExtractor()
    parser.feed(html)

    chefs = []
    current_chef = None
    current_item = None

    for level, text in parser.headings:
        if level == "h1":
            m = re.match(r"^\s*Chef\s*:\s*(.+?)\s*$", text, re.I)
            if not m:
                continue
            current_chef = {"name": m.group(1).strip(), "items": []}
            chefs.append(current_chef)
            current_item = None
        elif level == "h2":
            if current_chef is None:
                continue
            current_item = {"desc": text.strip(), "price": None, "code": None, "available": None}
            current_chef["items"].append(current_item)
        elif level == "h6":
            if current_item is None:
                continue
            m = re.match(r"^\s*Price\s*:\s*([\d.]+)", text, re.I)
            if m:
                current_item["price"] = round(float(m.group(1)))
                continue
            m = re.match(r"^\s*Menu\s*Code\s*:\s*(\S+)", text, re.I)
            if m:
                current_item["code"] = m.group(1).strip()
                continue
            m = re.match(r"^\s*Available\s*:\s*(\d+)", text, re.I)
            if m:
                current_item["available"] = int(m.group(1))
                continue

    # Drop any dish missing a required field -- skip a broken row rather
    # than show garbage (e.g. price 0 or a missing code).
    for chef in chefs:
        chef["items"] = [
            it for it in chef["items"]
            if it["price"] is not None and it["code"] is not None and it["available"] is not None
        ]
    chefs = [c for c in chefs if c["items"]]
    return chefs


def main():
    try:
        html = fetch(SOURCE_URL)
    except Exception as e:
        print(f"FETCH FAILED: {e}", file=sys.stderr)
        sys.exit(1)

    chefs = parse_menu(html)

    if len(chefs) < MIN_CHEFS_EXPECTED:
        print(f"REFUSING TO WRITE: only parsed {len(chefs)} chef(s) -- page structure "
              f"probably changed or the fetch returned something unexpected", file=sys.stderr)
        sys.exit(1)

    for i, chef in enumerate(chefs):
        chef["accent"] = ACCENTS[i % len(ACCENTS)]

    payload = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": SOURCE_URL,
        "chefs": chefs,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    total_dishes = sum(len(c["items"]) for c in chefs)
    print(f"OK: wrote {len(chefs)} chefs / {total_dishes} dishes to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
