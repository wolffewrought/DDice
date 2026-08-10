"""patchlib.py — write-at-end that actually holds.

The house rule is "a failed assert persists nothing". It does not survive
`io.open(path, 'w')`, which truncates the moment it opens: an encoding error
raised mid-write leaves a zero-byte file, and `node --check` passes on an
empty file, so the loop reports green over a destroyed source.

save() encodes the whole string to bytes first, refuses anything that is not
a plausible index.js, writes to a sibling temp file and renames it into
place. The target is never open for writing until the bytes exist.
"""
import io
import os


def load(path):
    return io.open(path, encoding='utf-8').read()


def save(path, text, min_bytes=1000, min_lines=None):
    # Encoding first, before the target is touched. A lone surrogate from a
    # mistyped \\uD83C escape dies here, with the original still on disk.
    try:
        data = text.encode('utf-8')
    except UnicodeEncodeError as e:
        raise SystemExit(f'REFUSED: {path} not written — {e}')
    if len(data) < min_bytes:
        raise SystemExit(f'REFUSED: {path} would be {len(data)} bytes, expected at least {min_bytes}')
    # Size alone does not prove structure. A join with a literal "\\n" instead
    # of a newline leaves the byte count almost unchanged and collapses the
    # whole file onto one line — still valid UTF-8, still large, still
    # ruinous. min_lines defaults to whatever the file has now, so any patch
    # that loses more than a tenth of its lines has to say so deliberately.
    if min_lines is None and os.path.exists(path):
        try:
            with io.open(path, encoding='utf-8') as f:
                min_lines = int(f.read().count('\n') * 0.9)
        except Exception:
            min_lines = None
    if min_lines:
        got = text.count('\n')
        if got < min_lines:
            raise SystemExit(f'REFUSED: {path} would have {got} lines, expected at least {min_lines}')
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)          # atomic: the file is either old or new
    return len(data)


def anchor(text, old, count=1, label='anchor'):
    """Assert an exact-string anchor appears exactly `count` times."""
    n = text.count(old)
    assert n == count, f'{label}: expected {count}, found {n}'
    return n
