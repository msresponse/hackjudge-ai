"""Quick check: test every API key in .env against the Gemini endpoint."""

import sys, os, requests
sys.stdout.reconfigure(encoding="utf-8")
from dotenv import load_dotenv

load_dotenv()

BASE_URL = os.getenv("AI_BASE_URL", "").strip().rstrip("/") + "/chat/completions"
MODEL    = os.getenv("AI_MODEL", "gemma-4-26b-a4b-it").strip()
KEYS     = [k.strip() for k in os.getenv("AI_API_KEY", "").split(",") if k.strip()]

PAYLOAD = {
    "model": MODEL,
    "messages": [{"role": "user", "content": "Say OK"}],
    "max_tokens": 5,
}

print(f"Endpoint : {BASE_URL}")
print(f"Model    : {MODEL}")
print(f"Total keys: {len(KEYS)}\n")
print(f"{'#':<4} {'Key (last 8)':<12} {'Status':<10} Detail")
print("-" * 60)

for i, key in enumerate(KEYS, 1):
    tail = key[-8:]
    try:
        r = requests.post(
            BASE_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=PAYLOAD,
            timeout=15,
        )
        if r.status_code == 200:
            status = "[OK]"
            detail = r.json().get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        else:
            status = f"[FAIL {r.status_code}]"
            try:
                detail = r.json().get("error", {}).get("message", r.text[:80])
            except Exception:
                detail = r.text[:80]
    except requests.exceptions.Timeout:
        status = "[TIMEOUT]"
        detail = "Request timed out after 15s"
    except Exception as e:
        status = "[ERROR]"
        detail = str(e)[:80]

    print(f"{i:<4} ...{tail:<12} {status:<10} {detail}")

print("\nDone.")
