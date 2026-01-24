#!/usr/bin/env python3
"""Transparent Copilot-provider smoke test for SAW.

This does NOT depend on the React UI.
It prints:
- the exact URL + JSON body being posted
- raw SSE lines received from the server
- parsed SAW events (JSON)

Usage:
  python3 scripts/test_saw_copilot_sse.py "hello" \
    --api http://127.0.0.1:5127 \
    --provider copilot

Notes:
- Requires SAW API running.
- For Copilot provider, SAW API must have Copilot SDK available.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def _iter_sse_lines(resp):
    # resp is an HTTPResponse
    while True:
        chunk = resp.readline()
        if not chunk:
            break
        try:
            yield chunk.decode("utf-8", errors="replace").rstrip("\n")
        except Exception:
            yield str(chunk)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("message", help="User message to send")
    ap.add_argument("--api", default="http://127.0.0.1:5127", help="SAW API base URL")
    ap.add_argument("--provider", default="copilot", choices=["copilot", "openai"], help="Agent provider")
    ap.add_argument("--conversation-id", default=None, help="Optional conversation id")
    args = ap.parse_args()

    url = f"{args.api.rstrip('/')}/agent/chat?stream=1&provider={args.provider}"
    body = {"conversation_id": args.conversation_id, "message": args.message}
    data = json.dumps(body).encode("utf-8")

    print("=== REQUEST ===")
    print("POST", url)
    print("Headers:")
    print("  Content-Type: application/json")
    print("Body:")
    print(json.dumps(body, indent=2, ensure_ascii=False))
    print("")

    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            print("=== RESPONSE ===")
            print("Status:", resp.status)
            print("Headers:")
            for k, v in resp.headers.items():
                lk = k.lower()
                if lk in ("date", "server", "content-type", "cache-control", "connection", "transfer-encoding"):
                    print(f"  {k}: {v}")
            print("")

            print("=== SSE (raw) ===")
            cur_event = None
            cur_data_lines: list[str] = []

            def flush_event():
                nonlocal cur_event, cur_data_lines
                if cur_event is None and not cur_data_lines:
                    return
                raw_data = "\n".join(cur_data_lines)
                if cur_event:
                    print(f"event: {cur_event}")
                if raw_data:
                    print(f"data: {raw_data}")

                # Try parse SAW event JSON (what SAW emits in `data:`)
                try:
                    ev = json.loads(raw_data)
                    if isinstance(ev, dict) and "type" in ev:
                        print("--- parsed ---")
                        print(json.dumps(ev, indent=2, ensure_ascii=False))
                except Exception:
                    pass

                print("")
                cur_event = None
                cur_data_lines = []

            for line in _iter_sse_lines(resp):
                # Print the raw line as well for maximum transparency.
                print(line)

                if line == "":
                    flush_event()
                    continue
                if line.startswith("event:"):
                    cur_event = line.split(":", 1)[1].strip()
                    continue
                if line.startswith("data:"):
                    cur_data_lines.append(line.split(":", 1)[1].lstrip())
                    continue

            flush_event()

    except urllib.error.HTTPError as e:
        print("HTTPError:", e.code)
        try:
            print(e.read().decode("utf-8", errors="replace"))
        except Exception:
            pass
        return 1
    except Exception as e:
        print("Error:", str(e))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
