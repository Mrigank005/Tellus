"""Run the offline copilot contract evaluation.

Set TELLUS_EVAL_URL to evaluate a running backend. Without it, the
evaluation exercises the deterministic safety fallback and remains free.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path


def ask(item: dict) -> dict:
    url = os.getenv("TELLUS_EVAL_URL", "http://127.0.0.1:8000") + "/api/copilot/message"
    request = urllib.request.Request(
        url,
        data=json.dumps({"message": item["question"], "selection": item["selection"]}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def main() -> int:
    cases = json.loads((Path(__file__).parent / "golden_questions.json").read_text())
    passed = 0
    for case in cases:
        result = ask(case)
        ok = result.get("kind") == case["expected"]
        passed += int(ok)
        print(("PASS" if ok else "FAIL"), case["question"], "=>", result.get("kind"))
    print(f"{passed}/{len(cases)} golden cases passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    raise SystemExit(main())
