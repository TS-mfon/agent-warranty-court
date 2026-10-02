#!/usr/bin/env python3
"""Build a deployable, comment-stripped copy of the Intelligent Contract.

Why this exists: GenLayer Bradbury refuses a deploy transaction whose gas is
near the block limit, and the documented 34 KB source estimates at ~27.3M gas
while the node accepts somewhere between 10M and 20M. The documentation is not
optional to *keep* — it carries the reasoning for every non-obvious decision in
the protocol — but it does not need to be *deployed*.

So the repository keeps the documented source as canonical and this build emits
the artifact that actually goes on chain. Two properties make that honest rather
than a shortcut:

* The transform only removes comments and docstrings. It uses `ast` to drop
  docstring expression statements and `tokenize` to drop comments, so it cannot
  alter an expression, reorder a statement, or change a string that something
  reads at runtime.
* `scripts/check-genlayer-build.mjs` runs the full direct-mode suite against the
  stripped artifact. If stripping changed behaviour, 48 tests notice.

Line 1 is preserved verbatim and deliberately: it is the `Depends` runner pin,
it is a comment, and dropping it would make the contract unloadable.

Usage: python3 script/build_genlayer.py [--out build/warranty_court.min.py]
"""

import argparse
import ast
import hashlib
import io
import pathlib
import sys
import tokenize

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "contracts" / "genlayer" / "warranty_court.py"


def strip_docstrings(source: str) -> str:
    """Remove module, class and function docstrings via the AST."""
    tree = ast.parse(source)
    drop_lines: set[int] = set()

    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", [])
        if not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            # A lone docstring in a function body must be replaced by `pass`,
            # not deleted, or the block becomes syntactically empty.
            lone = len(body) == 1
            for line in range(first.lineno, (first.end_lineno or first.lineno) + 1):
                drop_lines.add(line)
            if lone:
                indent = " " * first.col_offset
                drop_lines.discard(first.lineno)
                lines = source.splitlines()
                lines[first.lineno - 1] = f"{indent}pass"
                source = "\n".join(lines) + ("\n" if source.endswith("\n") else "")

    kept = [
        line
        for number, line in enumerate(source.splitlines(), start=1)
        if number not in drop_lines
    ]
    return "\n".join(kept) + "\n"


def strip_comments(source: str) -> str:
    """Remove comments with `tokenize`, keeping the first line verbatim."""
    lines = source.splitlines(keepends=True)
    if not lines:
        return source
    depends = lines[0]
    if "Depends" not in depends:
        raise SystemExit("refusing to build: line 1 is not the Depends runner pin")

    rest = "".join(lines[1:])
    out: list[str] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(rest).readline):
            if tok.type == tokenize.COMMENT:
                continue
            out.append(tok)
    except tokenize.TokenError as err:
        raise SystemExit(f"refusing to build: tokenize failed ({err})")

    rebuilt = tokenize.untokenize(out)
    # Deliberately no blank-line pruning. An earlier version collapsed
    # whitespace-only lines and silently deleted the blank lines *inside* the
    # multi-line adjudication prompt, changing the text every validator judges
    # against. The AST equivalence check caught it. Leftover blank lines cost
    # one byte each in calldata, which is not a reason to touch string content.
    return depends + rebuilt + ("" if rebuilt.endswith("\n") else "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "build" / "warranty_court.min.py"))
    args = parser.parse_args()

    original = SOURCE.read_text(encoding="utf-8")
    built = strip_comments(strip_docstrings(original))

    # Both must parse, and the stripped form must be *structurally identical*
    # under the AST with docstrings removed. This is the check that makes the
    # transform safe: it compares trees, not text, so a dropped statement or a
    # mangled expression cannot slip through.
    def normalised(src: str) -> str:
        tree = ast.parse(src)
        for node in ast.walk(tree):
            body = getattr(node, "body", None)
            if not isinstance(body, list) or not body:
                continue
            first = body[0]
            if not (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                continue
            # A docstring that was the whole body becomes `pass` in the built
            # artifact, so both forms normalise to `pass`; otherwise it is just
            # dropped. Normalising both sides the same way is what lets this
            # compare trees rather than text.
            if len(body) == 1:
                body[0] = ast.Pass()
            else:
                body.pop(0)
        return ast.dump(tree, annotate_fields=True, include_attributes=False)

    if normalised(original) != normalised(built):
        raise SystemExit("refusing to build: the stripped artifact is not AST-equivalent to the source")

    if "Depends" not in built.splitlines()[0]:
        raise SystemExit("refusing to build: Depends pin lost")
    if "def publishVerdict" not in built:
        raise SystemExit("refusing to build: the EVM emit interface was stripped")

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(built, encoding="utf-8")

    before, after = len(original.encode()), len(built.encode())
    print(f"source:  {before} bytes")
    print(f"built:   {after} bytes ({100 * after // before}% of source)")
    print(f"sha256:  {hashlib.sha256(built.encode()).hexdigest()}")
    print(f"out:     {out.relative_to(ROOT)}")
    print("genlayer build passed")


if __name__ == "__main__":
    sys.exit(main())
