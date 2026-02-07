from __future__ import annotations

import argparse
import json

from services.saw_api.app.agent_runtime.tools import tool_vector_search, tool_vector_store_stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Quick RAG sanity check against the SAW pgvector store.")
    parser.add_argument("--query", default="what are dogs{", help="Question to answer using DB context")
    parser.add_argument("--top-k", type=int, default=6, help="How many chunks to retrieve")
    parser.add_argument("--model", default=None, help="Embedding model override (optional)")
    parser.add_argument("--json", action="store_true", help="Print raw JSON result")
    args = parser.parse_args()

    stats = tool_vector_store_stats(model=args.model)
    search = tool_vector_search(query=args.query, top_k=args.top_k, model=args.model)

    if args.json:
        print(json.dumps({"stats": stats, "search": search}, indent=2))
        return 0

    hits = (search or {}).get("hits") or []
    top = hits[0] if hits else None

    print("Vector store stats:")
    print(json.dumps(stats, indent=2))
    print("\nQuery:")
    print(args.query)

    if not top:
        print("\nAnswer (from DB context):")
        print("No matching context found in vector store.")
        return 0

    # Minimal, deterministic "answer" for the smoke test: return the top chunk text.
    print("\nAnswer (from DB context):")
    print(top.get("content_text") or "")

    print("\nTop hit:")
    print(json.dumps({k: top.get(k) for k in ["uri", "doc_type", "distance", "metadata_json"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
