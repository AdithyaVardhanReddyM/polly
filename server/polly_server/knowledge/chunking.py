"""Cutting a file's text into passages for search and citation.

About 1 200 characters each, a few paragraphs: long enough to carry a whole
thought, short enough that a citation points somewhere specific. Cuts fall
between paragraphs, else between sentences (or lines, for tables and CSV),
and only mid-sentence when one sentence is longer than a chunk. Each chunk
repeats the last ~150 characters of the one before, so a fact that straddles
a cut is whole in at least one of them. A chunk never spans two pages, so it
cites one page.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from dataclasses import dataclass

SIZE = 1_200
OVERLAP = 150

_PARAGRAPHS = re.compile(r"\n\s*\n")
_SENTENCES = re.compile(r"(?<=[.!?。！？])\s+|\n")


@dataclass
class Page:
    # 1-based page number; None for files without pages.
    number: int | None
    text: str


@dataclass
class Chunk:
    index: int
    page: int | None
    text: str


def estimate_tokens(text: str) -> int:
    """Roughly: four characters a token."""
    return math.ceil(len(text) / 4)


def _pieces(text: str, size: int) -> Iterator[tuple[str, bool]]:
    """(piece, starts a paragraph), each at most `size` characters."""
    for paragraph in _PARAGRAPHS.split(text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= size:
            yield paragraph, True
            continue
        first = True
        for sentence in _SENTENCES.split(paragraph):
            sentence = sentence.strip()
            while len(sentence) > size:
                cut = sentence.rfind(" ", 0, size)
                cut = cut if cut > size // 2 else size
                yield sentence[:cut].rstrip(), first
                first = False
                sentence = sentence[cut:].lstrip()
            if sentence:
                yield sentence, first
                first = False


def _tail(text: str, overlap: int) -> str:
    """The last `overlap` characters, starting at a word."""
    if len(text) <= overlap:
        return text
    tail = text[-overlap:]
    space = tail.find(" ")
    return tail[space + 1 :] if 0 <= space < len(tail) - 1 else tail


def chunk_pages(pages: list[Page], size: int = SIZE, overlap: int = OVERLAP) -> list[Chunk]:
    chunks: list[Chunk] = []
    for page in pages:
        current = ""
        fresh = False  # holds more than the carried-over overlap
        for piece, starts_paragraph in _pieces(page.text, size):
            joiner = "\n\n" if starts_paragraph else " "
            if fresh and len(current) + len(joiner) + len(piece) > size:
                chunks.append(Chunk(len(chunks), page.number, current))
                current = _tail(current, overlap)
                fresh = False
            current = f"{current}{joiner}{piece}" if current else piece
            fresh = True
        if fresh:
            chunks.append(Chunk(len(chunks), page.number, current))
    return chunks
