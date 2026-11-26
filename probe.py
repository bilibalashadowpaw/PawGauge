"""Read-only probe: call each provider's quota endpoint once per account and print
the response SHAPE. Keys are read from ~/.claude/settings.*.json and sent only to
their own provider host. Keys are never printed. Hard 15s timeout per request."""
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")

# provider -> list of (url) candidates, tried in order until one returns HTTP 200
PROVIDERS = {
    "zai": ["https://api.z.ai/api/monitor/usage/quota/limit"],
    "minimax": [
        "https://api.minimax.io/v1/token_plan/remains",
        "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    ],
    "deepseek": ["https://api.deepseek.com/user/balance"],
}


def provider_for(base_url):
    host = re.sub(r"^https?://", "", base_url).split("/")[0]
    host = host.rsplit("@", 1)[-1].split(":")[0].lower()
    # Whole domains only (the same list as src/main/providers/index.js): a relay's key must never reach the provider.
    for provider, domain in (("zai", "z.ai"), ("minimax", "minimax.io"), ("deepseek", "deepseek.com")):
        if host == domain or host.endswith("." + domain):
            return provider
    return None


def scrub(obj, key):
    """Return obj with the key redacted and long strings truncated."""
    if isinstance(obj, dict):
        return {k: scrub(v, key) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v, key) for v in obj]
    if isinstance(obj, str):
        if key and key in obj:
            return "<REDACTED>"
        return obj if len(obj) <= 60 else obj[:57] + "..."
    return obj


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib re-sends the Authorization header to a redirect target; never follow one."""

    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch(url, key):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "pawgauge-probe/0.1",
        },
    )
    try:
        with _OPENER.open(req, timeout=15) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # network, timeout, TLS
        return None, f"{type(e).__name__}: {e}"


def main():
    files = sorted(glob.glob(os.path.join(CLAUDE_DIR, "settings.*.json")))
    files += glob.glob(os.path.join(CLAUDE_DIR, "settings.json"))
    for f in files:
        name = os.path.basename(f)[len("settings."):-len(".json")] or "default"
        try:
            env = json.load(open(f, encoding="utf-8")).get("env", {})
        except Exception as e:
            print(f"[{name}] unreadable settings: {e}")
            continue
        base = env.get("ANTHROPIC_BASE_URL", "")
        key = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
        prov = provider_for(base) if base else None
        if not prov or not key:
            print(f"[{name}] skipped (provider={prov}, has_key={bool(key)})")
            continue
        print(f"\n=== {name}  provider={prov}  key_len={len(key)} ===")
        for url in PROVIDERS[prov]:
            status, body = fetch(url, key)
            print(f"GET {url} -> {status}")
            try:
                shown = json.dumps(scrub(json.loads(body), key), indent=2, ensure_ascii=False)
            except Exception:
                shown = scrub(body[:400], key)
            print(shown if len(shown) < 3000 else shown[:3000] + "\n...[truncated]")
            if status == 200:
                break


if __name__ == "__main__":
    sys.exit(main())
