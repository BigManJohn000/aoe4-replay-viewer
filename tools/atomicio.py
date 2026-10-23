"""Atomically publish text files without exposing partial contents."""
import os
from pathlib import Path


def atomic_write_text(path: Path, text: str, encoding="utf-8") -> None:
    path = Path(path)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding=encoding, newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
