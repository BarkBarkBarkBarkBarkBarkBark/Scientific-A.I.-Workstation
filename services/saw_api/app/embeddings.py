from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from openai import OpenAI

from .settings import Settings


@dataclass(frozen=True)
class EmbedResult:
    model: str
    vectors: list[list[float]]


def chunk_text(text: str, max_chars: int = 4000, overlap: int = 300) -> list[str]:
    t = (text or "").strip()
    if not t:
        return []
    if max_chars <= 0:
        return [t]
    if len(t) <= max_chars:
        return [t]
    out: list[str] = []
    step = max(1, max_chars - max(0, overlap))
    i = 0
    while i < len(t):
        out.append(t[i : i + max_chars])
        i += step
    return out


def embed_texts(settings: Settings, texts: Iterable[str], model: str) -> EmbedResult:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    client = OpenAI(api_key=settings.openai_api_key)
    inputs = [t for t in (texts or []) if (t or "").strip()]
    if not inputs:
        return EmbedResult(model=model, vectors=[])
    r = client.embeddings.create(model=model, input=inputs)
    vectors: list[list[float]] = []
    for item in r.data:
        vectors.append(list(item.embedding))
    return EmbedResult(model=model, vectors=vectors)


