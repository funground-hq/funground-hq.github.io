"""Python text to blockly-fun's blocks (Architecture section 5, phase B).

    to_blocks(source) -> dict      Blockly's workspace JSON (its standard serialisation)
    convert(source) -> dict        what a host wants: {"ok": True, "workspace": ..., "raw": n}
                                   or {"ok": False, "line": n, "message": "..."}

The blocks are the ones the editor's generator turns back into Python (editor/generator/python.js), so the two
sides keep the round-trip contract:

1. blocks -> Python -> blocks gives the same blocks;
2. Python in the plain style -> blocks -> Python gives the same text, byte for byte;
3. nothing is lost: the smallest part with no block becomes a "Python code" block holding its exact text.

Comments and blank lines are not in Python's tree, so they come from `tokenize`:

- a comment at the end of a line belongs to that line's block (marked "trailing");
- comments on their own lines directly above a statement belong to its block;
- the blank lines before a statement are a count on its block;
- comments with no block to belong to (followed by a blank line, at the end of a body, or above a statement that
  already has an end-of-line comment) become a "Python code" block holding them, so they come back as written;
- a comment where no block can keep it (inside a statement that spans lines, on an `elif` or `else` line) makes
  that statement a "Python code" block.

Standard library only, so the same file runs in CPython and in Pyodide.
"""

from __future__ import annotations

import ast
import bisect
import io
import re
import tokenize
import unicodedata

PREFIX = "bf_"

# Modules a named block needs; the generator writes their imports at the top itself.
IMPORT_ORDER = ("math", "random", "time")

# Phase C+ (BF-D-022): funground's drawing kit, for a program that starts with `import funground as f`.
# (method, number of arguments) -> (block, its slots in order)
_DRAWING = {
    ("size", 2): ("canvas_size", ("W", "H")),
    ("background", 1): ("background", ("COLOR",)),
    ("fill", 1): ("fill", ("COLOR",)),
    ("stroke", 1): ("outline", ("COLOR",)),
    ("circle", 3): ("circle", ("X", "Y", "D")),
    ("rect", 4): ("rectangle", ("X", "Y", "W", "H")),
    ("line", 4): ("line", ("X1", "Y1", "X2", "Y2")),
    ("text", 3): ("write", ("TEXT", "X", "Y")),
}
_SKETCH_VALUES = ("mouse_x", "mouse_y", "width", "height", "frame_count")
_HATS = {"setup": "sketch_start", "draw": "sketch_frame"}
_TOP_BLOCKS = {"bf_def", "bf_sketch_start", "bf_sketch_frame"}   # each a stack of its own (BF-D-013)
_KIT = {PREFIX + kind for kind in (*_HATS.values(), *(kind for kind, _ in _DRAWING.values()), "sketch_value")}

# The names a "Python code" block's text uses, as the generator reads them (python.js sharedNames): comments and
# strings left out, and a name after a dot is an attribute, not a name.
_CODE_NOISE = re.compile(r"\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''|\"(?:[^\"\\\n]|\\.)*\"|'(?:[^'\\\n]|\\.)*'|#[^\n]*")
_CODE_NAME = re.compile(r"(?<![.\w])[A-Za-z_]\w*")
_VARIABLE_FIELD_BLOCKS = {PREFIX + t for t in ("set", "change", "subtract", "variable", "count", "count_by", "for_each")}
_ASSIGNING = {PREFIX + t for t in ("set", "change", "subtract")}

_ARITH = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/"}
_BINARY_BLOCK = {ast.FloorDiv: "floordiv", ast.Mod: "mod", ast.Pow: "power"}
_COMPARE = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.Gt: ">", ast.LtE: "<=", ast.GtE: ">="}
# builtins with a named block of one slot, X
_CALL1 = {"int": "to_int", "float": "to_float", "str": "to_str", "round": "round", "abs": "abs", "len": "length"}

# The generator's precedence levels (python.js ORDER) by name. A "Python code" value says its level, so the generator
# puts brackets round it exactly where Python needs them.
_ORDER_OF_OPERATOR = {
    ast.Pow: "EXPONENT",
    ast.Mult: "MULTIPLICATIVE", ast.Div: "MULTIPLICATIVE", ast.FloorDiv: "MULTIPLICATIVE",
    ast.Mod: "MULTIPLICATIVE", ast.MatMult: "MULTIPLICATIVE",
    ast.Add: "ADDITIVE", ast.Sub: "ADDITIVE",
    ast.LShift: "SHIFT", ast.RShift: "SHIFT",
    ast.BitAnd: "BITWISE_AND", ast.BitXor: "BITWISE_XOR", ast.BitOr: "BITWISE_OR",
}

# What the editor's number field accepts (register.js numberValidator); other numbers stay Python code.
_NUMBER = re.compile(r"-?(\d+\.?\d*|\.\d+)\Z")
_KEYWORDS = frozenset(
    "False None True and as assert async await break class continue def del elif else except finally for from "
    "global if import in is lambda nonlocal not or pass raise return try while with yield".split()
)
_NEWLINE = re.compile(r"\r\n|\r|\n")

# Statements with blocks of their own that have a header and bodies; the other compound statements are Python code.
_BLOCK_COMPOUND = (ast.If, ast.For, ast.While, ast.FunctionDef)

# Where the stacks go on the workspace: one row of text is about one block high. Positions never change the Python
# (the generator writes the stacks from the top down) and they are rough: blocks with a Python line are taller, so a
# page arranges the stacks by their drawn height after loading (Blockly's cleanUp keeps their order).
_STACK_X = 20
_ROW_HEIGHT = 56

# A comment's bubble, as Blockly saves it.
_COMMENT_SIZE = {"pinned": False, "height": 80, "width": 160}


class SourceError(Exception):
    """The text is not Python yet, so it cannot become blocks."""

    def __init__(self, line: int, message: str, detail: str = ""):
        super().__init__(message)
        self.line = line
        self.message = message
        self.detail = detail  # Python's own words, for a host that wants them


def is_name(text: str) -> bool:
    """True for a name the editor's fields accept (register.js isName): letters, digits and _, not a keyword."""
    if not text or text in _KEYWORDS:
        return False
    first_ok = text[0] == "_" or unicodedata.category(text[0]).startswith("L")
    return first_ok and all(ch == "_" or unicodedata.category(ch)[0] in "LN" for ch in text[1:])


def to_blocks(source: str) -> dict:
    """Blockly's workspace JSON for a Python program. Raises SourceError if the text does not parse."""
    return _Converter(source).workspace()


def convert(source: str) -> dict:
    """The host's call: the workspace and how many "Python code" blocks it has, or the line that stops it."""
    try:
        workspace = to_blocks(source)
    except SourceError as error:
        return {"ok": False, "line": error.line, "message": error.message}
    return {"ok": True, "workspace": workspace, "raw": count_code_blocks(workspace)}


def count_code_blocks(workspace: dict) -> int:
    """How many "Python code" blocks (statement or value) a workspace has."""
    def count(block: dict) -> int:
        own = block["type"] in (PREFIX + "code", PREFIX + "code_value")
        inner = sum(count(value[key]) for value in block.get("inputs", {}).values() for key in value)
        after = count(block["next"]["block"]) if "next" in block else 0
        return own + inner + after
    return sum(count(top) for top in workspace.get("blocks", {}).get("blocks", []))


def _walk(block: dict):
    """A block and every block in it, in order: the block, its slots' blocks, then the block after it."""
    yield block
    for value in block.get("inputs", {}).values():
        inner = value.get("block") or value.get("shadow")
        if inner:
            yield from _walk(inner)
    after = block.get("next", {}).get("block")
    if after:
        yield from _walk(after)


def _shared_names(hat: dict, others: list[dict]) -> list[str]:
    """The `global` names of a hat, by python.js sharedNames' rule: the names it sets (set, change, subtract) that
    the other top blocks use (a variable field, or a name in a "Python code" text), in the order it first sets them."""
    assigned: list[str] = []
    for block in _walk(hat):
        if block["type"] in _ASSIGNING and block["fields"]["VAR"] not in assigned:
            assigned.append(block["fields"]["VAR"])
    if not assigned:
        return []
    outside: set[str] = set()
    for top in others:
        for block in _walk(top):
            if block["type"] in _VARIABLE_FIELD_BLOCKS:
                outside.add(block["fields"]["VAR"])
            if block["type"] in (PREFIX + "code", PREFIX + "code_value"):
                outside.update(_CODE_NAME.findall(_CODE_NOISE.sub(" ", block["fields"]["TEXT"])))
    return [name for name in assigned if name in outside]


def _parses_alone(text: str) -> bool:
    """True when the text is one expression as it stands (its line breaks inside its own brackets)."""
    try:
        ast.parse(text, mode="eval")
    except SyntaxError:
        return False
    return True


# ---------------------------------------------------------------------------------------------------------------
# Blocks as JSON


def _block(kind: str, fields=None, inputs=None, extra=None) -> dict:
    block = {"type": PREFIX + kind}
    if extra:
        block["extraState"] = extra
    if fields:
        block["fields"] = fields
    if inputs:
        block["inputs"] = inputs
    return block


def _slot(block: dict) -> dict:
    """A value in a slot: a typed literal is a shadow (typed over, or covered by a dropped block), others blocks."""
    if block["type"] in (PREFIX + "number", PREFIX + "text"):
        return {"shadow": block}
    return {"block": block}


def _chain(blocks: list[dict]) -> dict:
    """Statements one under the other: each one's `next` is the one after it."""
    for upper, lower in zip(blocks, blocks[1:]):
        upper["next"] = {"block": lower}
    return blocks[0]


def _is_bare_pass(block: dict) -> bool:
    """A `pass` with no comment and no blank line: what the generator writes for an empty body."""
    return block == {"type": PREFIX + "code", "fields": {"TEXT": "pass"}}


class _Comment:
    __slots__ = ("row", "col", "text", "trailing")

    def __init__(self, row: int, col: int, token: str, trailing: bool):
        self.row, self.col, self.trailing = row, col, trailing
        # the text as the generator writes it back, after "# " (or "#" for an empty one)
        text = token[1:]
        self.text = text[1:] if text.startswith(" ") else text


# ---------------------------------------------------------------------------------------------------------------
# The converter


class _Converter:
    def __init__(self, source: str):
        self.source = source
        self.lines = _NEWLINE.split(source)
        try:
            self.tree = ast.parse(source)
            tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
        except SyntaxError as error:  # IndentationError and TabError are SyntaxErrors too
            line = error.lineno or 1
            raise SourceError(line, f"Line {line} is not finished Python yet, so it cannot become blocks.",
                              error.msg) from None
        except (ValueError, tokenize.TokenError) as error:
            raise SourceError(1, "This text is not Python yet, so it cannot become blocks.", str(error)) from None

        self.comments: dict[int, _Comment] = {}
        self.code_starts: list[tuple[int, int]] = []  # where each piece of code starts and ends, in order
        self.code_ends: list[tuple[int, int]] = []
        layout = (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER)
        for token in tokens:
            if token.type == tokenize.COMMENT:
                row, col = token.start
                self.comments[row] = _Comment(row, col, token.string, token.line[:col].strip() != "")
            elif token.type not in layout:
                self.code_starts.append(token.start)
                self.code_ends.append(token.end)
        self.used: set[int] = set()  # rows of the comments given a place
        self.needs: set[str] = set()  # modules the blocks need imported
        self.own_functions = {node.name for node in self.tree.body
                              if isinstance(node, ast.FunctionDef) and self._is_simple_def(node)}
        self.kept_whole = self._top_statements_kept_whole()
        self.indent = ""  # the indentation of the statement being converted (its value's lines are written under it)
        self.funground = False  # the program starts with `import funground as f`: the drawing kit's blocks apply
        self.hats: list[tuple[dict, ast.FunctionDef, list[str]]] = []  # each hat made, its def, its global names
        self.hats_off = False

    def _top_statements_kept_whole(self) -> set[int]:  # ids of the statements
        """
        The top-level statements that stay one "Python code" block, as written: those holding a string over several
        lines that the generator's indentation would change. Below the top level the generator writes each line at
        4 spaces a level; a string's inner lines move with it. That is exact only when the statement around the string
        is indented 4 spaces a level and every inner line starts with that indentation (or is empty). Otherwise the
        string's value would change, so the statement is kept whole at the top, where nothing is re-indented.
        """
        kept = set()

        def visit(node: ast.AST, top: int, depth: int, indent: str) -> None:
            if isinstance(node, ast.stmt):
                line = self.lines[node.lineno - 1]
                indent = line[:len(line) - len(line.lstrip())]
            if (isinstance(node, (ast.Constant, ast.JoinedStr)) and node.end_lineno > node.lineno
                    and isinstance(getattr(node, "value", ""), (str, bytes)) and depth > 0):
                inner = self.lines[node.lineno:node.end_lineno]
                if indent != " " * 4 * depth or any(line and not line.startswith(indent) for line in inner):
                    kept.add(id(top))
            owns_bodies = isinstance(node, (ast.stmt, ast.excepthandler, ast.match_case))
            for name, value in ast.iter_fields(node):
                for child in value if isinstance(value, list) else [value]:
                    if not isinstance(child, ast.AST):
                        continue
                    nested = (isinstance(child, ast.stmt) and owns_bodies and name in ("body", "orelse", "finalbody")
                              or isinstance(child, ast.match_case))   # a `case` is a level below its `match`
                    visit(child, top, depth + 1 if nested else depth, indent)

        for statement in self.tree.body:
            visit(statement, statement, 0, "")
        return kept

    # -- the program --------------------------------------------------------------------------------------------

    def workspace(self) -> dict:
        imports = self._taken_imports()
        # Imports below a comment (a file's header) stay as written, so the comment stays above them.
        if imports and any(row < imports[0].lineno for row in self.comments):
            imports = []
        # The kit's blocks apply wherever the program imports funground as f at the top level (below a docstring
        # too); the generator writes the import and the ending only when it took the import in.
        self.funground = any(isinstance(node, ast.Import) and len(node.names) == 1
                             and (node.names[0].name, node.names[0].asname) == ("funground", "f") for node in self.tree.body)
        statements = self.tree.body[len(imports):]
        pieces = self._statements(statements, anchor=0, limit=len(self.lines), top=True)
        self._check_hats([block for block, _ in pieces])
        if not any(block["type"] in _KIT for piece, _ in pieces for block in _walk(piece)):
            self.needs.discard("funground")   # a hat converted again as a def leaves nothing of the kit

        # A sketch's `import funground as f` and its ending are the generator's to write when the blocks need
        # funground and the ending is the one it writes: f.run() after an "every frame" hat, f.show() without one.
        # Otherwise both stay as written (the import as Python code at the top, the ending a block of its own).
        taken = any(node.names[0].name == "funground" for node in imports)
        ending = self._ending(statements) if taken and "funground" in self.needs else None
        if ending is not None:
            frame = any(block["type"] == PREFIX + "sketch_frame" for block, _ in pieces)
            if (ending.value.func.attr == "run") == frame:
                pieces = [piece for piece in pieces if piece[1] != ending.lineno]
            else:
                ending = None
        if ending is None:
            self.needs.discard("funground")

        # Each "make a block" and each hat is a stack of its own; the statements between them are a stack (BF-D-013).
        stacks: list[list[tuple[dict, int]]] = []
        for piece in pieces:
            if piece[0]["type"] in _TOP_BLOCKS or not stacks or stacks[-1][0][0]["type"] in _TOP_BLOCKS:
                stacks.append([piece])
            else:
                stacks[-1].append(piece)

        # An import no block needs is kept as written, as Python code at the top.
        unused = [node for node in imports if node.names[0].name not in self.needs]
        if unused:
            stacks.insert(0, [(self._code_statement(node), node.lineno) for node in unused])
        if not stacks:
            return {}

        # The generator writes the imports it took in, one blank line, then the program from its first block's blank
        # lines on (two before a def, as PEP 8 has it, is one more). With no imports to write, the first block has none.
        first = stacks[0][0][0]
        if "blank" in first.get("extraState", {}):
            written = not unused and len(imports) > 0
            first["extraState"]["blank"] -= 1 if written else first["extraState"]["blank"]
            if not first["extraState"]["blank"]:
                del first["extraState"]["blank"]
            if not first["extraState"]:
                del first["extraState"]

        tops = []
        for stack in stacks:
            top = _chain([block for block, _ in stack])
            top["x"], top["y"] = _STACK_X, (stack[0][1] - 1) * _ROW_HEIGHT
            tops.append(top)
        return {"blocks": {"languageVersion": 0, "blocks": tops}}

    def _taken_imports(self) -> list[ast.Import]:
        """The `import math` / `random` / `time` and `import funground as f` lines at the very top: the generator
        writes these itself."""
        taken = []
        for node in self.tree.body:
            if not (isinstance(node, ast.Import) and len(node.names) == 1 and node.lineno not in self.comments):
                break
            alias = node.names[0]
            if not (alias.asname is None and alias.name in IMPORT_ORDER or (alias.name, alias.asname) == ("funground", "f")):
                break
            taken.append(node)
        return taken

    # -- a sketch (phase C+, BF-D-022) ----------------------------------------------------------------------------

    def _hat(self, node: ast.FunctionDef) -> dict | None:
        """`def setup():` or `def draw():` as its hat, without the `global` line the generator writes itself (checked
        against the blocks once the program is converted: _check_hats). None when it cannot be one."""
        if self.hats_off or not (self.funground and node.name in _HATS and self._is_simple_def(node) and not node.args.args):
            return None
        body, anchor = node.body, self._header_end(node)
        written: list[str] = []
        if isinstance(body[0], ast.Global):
            if len(body) == 1 or any(row in self.comments for row in range(anchor + 1, body[0].end_lineno + 1)):
                return None   # nothing after it, or a comment that would go with the line
            written, anchor, body = list(body[0].names), body[0].end_lineno, body[1:]
        self.needs.add("funground")
        block = _block(_HATS[node.name], inputs=self._body("DO", body, anchor, self._next_code_row(node.end_lineno) - 1))
        self.hats.append((block, node, written))
        return block

    def _check_hats(self, tops: list[dict]) -> None:
        """Each hat's `global` line as written must be the one the generator writes for its blocks (python.js
        sharedNames); otherwise the def is converted again as an ordinary def, so the program stays the same."""
        for block, node, written in self.hats:
            if _shared_names(block, [top for top in tops if top is not block]) == written:
                continue
            kept = {key: block[key] for key in ("extraState", "icons") if key in block}
            block.clear()
            self.hats_off = True   # converted again as an ordinary def, not as a hat: its own comments placed again
            self.used -= set(range(self._header_end(node) + 1, node.end_lineno + 1))
            block.update(self._statement_block(node, top=True) or self._code_statement(node))
            self.hats_off = False
            block.update(kept)

    def _ending(self, statements: list[ast.stmt]) -> ast.stmt | None:
        """The `f.run()` or `f.show()` a sketch ends with, which the generator writes itself (with no comment of its
        own: a comment above it or at its end would go with it)."""
        if not statements:
            return None
        last = statements[-1]
        call = last.value if isinstance(last, ast.Expr) else None
        if not (isinstance(call, ast.Call) and not call.args and not call.keywords
                and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
                and call.func.value.id == "f" and call.func.attr in ("run", "show")):
            return None
        if last.lineno in self.comments or last.lineno - 1 in self.comments:
            return None
        return last

    # -- lists of statements, with their comments and blank lines ------------------------------------------------

    def _statements(self, nodes: list[ast.stmt], anchor: int, limit: int, top: bool = False,
                    any_column: bool = False) -> list[tuple[dict, int]]:
        """
        The blocks of a list of statements and the comments around them, each with the row it starts on.
        `anchor` is the last row before the first statement that is not theirs (a header, or 0 at the top); `limit`
        the last row whose comments they may take after the last statement. After the last statement a body takes
        the comments indented with it (or, with any_column, all of them, as before an `else`); the top takes all.
        """
        pieces: list[tuple[dict, int]] = []
        previous_end = anchor
        for index, node in enumerate(nodes):
            start = self._start_row(node)
            groups, blanks = self._comments_above(previous_end, start)
            block = self._statement(node, top)
            trailing = None
            if block["type"] != PREFIX + "code":  # a code block's text holds its end-of-line comment already
                following = nodes[index + 1] if index + 1 < len(nodes) else None
                trailing = self._trailing_comment(node, following)
            pieces.extend(self._place_comments(block, start, groups, blanks, trailing))
            previous_end = node.end_lineno
        column = None if top or any_column or not nodes else nodes[0].col_offset
        pieces.extend(self._comments_after(previous_end, limit, column))
        return pieces

    def _start_row(self, node: ast.stmt) -> int:
        decorators = getattr(node, "decorator_list", None) or []
        return min([node.lineno] + [d.lineno for d in decorators])

    def _comments_above(self, previous_end: int, start: int) -> tuple[list[tuple[int, list[_Comment]]], int]:
        """
        The groups of comments between two statements, each with the blank lines before it, and the blank lines
        between the last group (or the statement before) and the statement.
        """
        groups: list[tuple[int, list[_Comment]]] = []
        blanks = 0
        current: list[_Comment] | None = None
        for row in range(previous_end + 1, start):
            comment = self.comments.get(row)
            if comment is not None and not comment.trailing and row not in self.used:
                if current is None:
                    current = []
                    groups.append((blanks, current))
                    blanks = 0
                current.append(comment)
                self.used.add(row)
            elif self.lines[row - 1].strip() == "":
                blanks += 1
                current = None
            else:  # code that is not a statement of this list (an import taken in), or a comment placed already
                blanks = 0
                current = None
        return groups, blanks

    def _comments_after(self, previous_end: int, limit: int, column: int | None) -> list[tuple[dict, int]]:
        """The comments after the last statement, down to `limit`, as comment blocks (indented with it, if column)."""
        groups, _ = self._comments_above(previous_end, self._first_lower(previous_end, limit, column) + 1)
        return [(self._comment_block(comments, blanks), comments[0].row) for blanks, comments in groups]

    def _first_lower(self, previous_end: int, limit: int, column: int | None) -> int:
        """The last row before a comment indented less than `column`, or limit: a body's comments end there."""
        if column is None:
            return limit
        for row in range(previous_end + 1, limit + 1):
            comment = self.comments.get(row)
            if comment is not None and not comment.trailing and comment.col < column:
                return row - 1
        return limit

    def _place_comments(self, block: dict, start: int, groups, blanks: int, trailing: _Comment | None):
        """The statement's block with its comment and blank lines, after comment blocks for the comments above it
        that are not its own. A group directly above (no blank line between) is the block's comment, unless the block
        has an end-of-line comment: a block has one comment."""
        pieces = []
        own = None
        if groups and blanks == 0 and trailing is None:
            own = groups.pop()
            blanks = own[0]
        for before, comments in groups:
            pieces.append((self._comment_block(comments, before), comments[0].row))
        extra = block.setdefault("extraState", {})
        if blanks:
            extra["blank"] = blanks
        if trailing is not None:
            self.used.add(trailing.row)
            extra["trailing"] = True
            block["icons"] = {"comment": {"text": trailing.text, **_COMMENT_SIZE}}
        elif own is not None:
            block["icons"] = {"comment": {"text": "\n".join(c.text for c in own[1]), **_COMMENT_SIZE}}
        if not extra:
            del block["extraState"]
        pieces.append((block, own[1][0].row if own else start))
        return pieces

    def _comment_block(self, comments: list[_Comment], blanks: int) -> dict:
        """Comments with no statement to belong to: Python code, so they come back exactly as written."""
        text = "\n".join(self.lines[c.row - 1].strip() for c in comments)
        return _block("code", fields={"TEXT": text}, extra={"blank": blanks} if blanks else None)

    def _trailing_comment(self, node: ast.stmt, following: ast.stmt | None) -> _Comment | None:
        """The comment at the end of the statement's own (first) line, if the line is its own."""
        if isinstance(node, _BLOCK_COMPOUND):
            row = self._header_end(node)
            if node.body[0].lineno == row:  # `if x: y()  # c`: the comment is y's
                return None
        else:
            row = node.end_lineno
        comment = self.comments.get(row)
        if comment is None or not comment.trailing or row in self.used:
            return None
        if following is not None and following.lineno == row:  # `a = 1; b = 2  # c`: the comment is b's
            return None
        return comment

    # -- rows ----------------------------------------------------------------------------------------------------

    def _row_before(self, row: int, col: int) -> int:
        """The row where the last piece of code before (row, col) ends."""
        return self.code_ends[bisect.bisect_left(self.code_ends, (row, col)) - 1][0]

    def _header_end(self, node: ast.stmt) -> int:
        """The row of the colon that ends a compound statement's (first) header."""
        first = node.body[0]
        return self._row_before(self._start_row(first), self._start_col(first))

    def _start_col(self, node: ast.stmt) -> int:
        decorators = getattr(node, "decorator_list", None) or []
        return min([node.col_offset] + [d.col_offset - 1 for d in decorators])  # the "@" is before the decorator

    def _next_code_row(self, row: int) -> int:
        """The first row after `row` that has code on it, or one past the end."""
        index = bisect.bisect_left(self.code_starts, (row + 1, 0))
        return self.code_starts[index][0] if index < len(self.code_starts) else len(self.lines) + 1

    def _else_row(self, body: list[ast.stmt]) -> int:
        """The row of the `else:` above an else body."""
        return self._row_before(self._start_row(body[0]), self._start_col(body[0]))

    # -- one statement -------------------------------------------------------------------------------------------

    def _statement(self, node: ast.stmt, top: bool) -> dict:
        """The block for one statement, or a "Python code" block with its exact text."""
        if top and id(node) in self.kept_whole:
            return self._code_statement(node)
        line = self.lines[self._start_row(node) - 1]
        outer, self.indent = self.indent, line[:len(line) - len(line.lstrip())]
        try:
            block = None if self._comment_inside(node) else self._statement_block(node, top)
        finally:
            self.indent = outer
        return block if block is not None else self._code_statement(node)

    def _comment_inside(self, node: ast.stmt) -> bool:
        """True when a comment sits in the statement's own lines where no block can keep it: on a line of a statement
        or header that spans lines (other than an end-of-line comment on its last line), or on an `elif` or `else`
        line."""
        if not isinstance(node, _BLOCK_COMPOUND):
            return any(row in self.comments for row in range(self._start_row(node), node.end_lineno))
        header_end = self._header_end(node)
        if any(row in self.comments for row in range(self._start_row(node), header_end)):
            return True
        return any(row in self.comments for first, last in self._branch_headers(node) for row in range(first, last + 1))

    def _branch_headers(self, node: ast.stmt) -> list[tuple[int, int]]:
        """The rows of the `elif` and `else` lines of an if (each from its keyword to its colon)."""
        spans = []
        current = node
        while isinstance(current, ast.If) and current.orelse:
            if self._is_elif(current):
                current = current.orelse[0]
                spans.append((current.lineno, self._header_end(current)))
            else:
                row = self._else_row(current.orelse)
                spans.append((row, row))
                break
        return spans

    def _is_elif(self, node: ast.If) -> bool:
        if len(node.orelse) != 1 or not isinstance(node.orelse[0], ast.If):
            return False
        inner = node.orelse[0]
        return self.lines[inner.lineno - 1][inner.col_offset:].startswith("elif")

    def _code_statement(self, node: ast.stmt) -> dict:
        """A "Python code" block with the statement's exact text (and its end-of-line comment), unindented."""
        start, end = self._start_row(node), node.end_lineno
        first_line = self.lines[start - 1]
        indent = first_line[:len(first_line) - len(first_line.lstrip())]
        rows = []
        for row in range(start, end + 1):
            line = self.lines[row - 1]
            if row == end:
                rest = line[node.end_col_offset:]
                line = line.rstrip() if rest.strip().startswith("#") else line[:node.end_col_offset]
            if row == start:
                line = line[self._start_col(node):]
            elif line.startswith(indent):
                line = line[len(indent):]
            elif line.strip() == "":
                line = ""
            rows.append(line)
            if row in self.comments:
                self.used.add(row)
        return _block("code", fields={"TEXT": "\n".join(rows)})

    def _statement_block(self, node: ast.stmt, top: bool) -> dict | None:
        if isinstance(node, ast.Expr):
            return self._expression_statement(node.value)
        if isinstance(node, ast.Assign):
            return self._assign(node)
        if isinstance(node, ast.AugAssign):
            kind = {ast.Add: "change", ast.Sub: "subtract"}.get(type(node.op))
            if kind and isinstance(node.target, ast.Name) and is_name(node.target.id):
                return _block(kind, fields={"VAR": node.target.id}, inputs=self._inputs(VALUE=node.value))
            return None
        if isinstance(node, ast.For):
            return self._for(node)
        if isinstance(node, ast.While):
            return self._while(node)
        if isinstance(node, ast.If):
            return self._if(node)
        if isinstance(node, ast.Break):
            return _block("break")
        if isinstance(node, ast.Continue):
            return _block("continue")
        if isinstance(node, ast.Return):
            return _block("return", inputs=self._inputs(optional={"VALUE"}, VALUE=node.value))
        if isinstance(node, ast.FunctionDef) and top and (hat := self._hat(node)) is not None:
            return hat
        if isinstance(node, ast.FunctionDef) and top and node.name in self.own_functions:
            params = ", ".join(a.arg for a in node.args.args)
            return _block("def", fields={"NAME": node.name, "PARAMS": params}, inputs=self._body_of(node))
        return None  # pass, import, try, with, class, del, global, ...: Python code

    def _is_simple_def(self, node: ast.FunctionDef) -> bool:
        """A def the "make a block" block can hold: plain parameters, no defaults, annotations or decorators."""
        a = node.args
        return (not node.decorator_list and node.returns is None and not getattr(node, "type_params", None)
                and is_name(node.name) and not a.posonlyargs and not a.vararg and not a.kwonlyargs and not a.kwarg
                and not a.defaults and all(p.annotation is None and is_name(p.arg) for p in a.args))

    def _expression_statement(self, call: ast.expr) -> dict | None:
        if not isinstance(call, ast.Call) or self._awkward_call(call):
            return None
        func, args, positional_only = call.func, call.args, not call.keywords
        if isinstance(func, ast.Name):
            if func.id == "print" and positional_only:
                return self._items("say", args)
            if func.id in self.own_functions and positional_only:
                return self._own("own_call", func.id, args)
            return self._call("call", call)
        if (self.funground and positional_only and isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)
                and func.value.id == "f" and (func.attr, len(args)) in _DRAWING):
            kind, slots = _DRAWING[func.attr, len(args)]
            self.needs.add("funground")
            return _block(kind, inputs=self._inputs(**dict(zip(slots, args))))
        if isinstance(func, ast.Attribute) and positional_only and len(args) == 1:
            target, method = func.value, func.attr
            if isinstance(target, ast.Name) and target.id == "time" and method == "sleep":
                self.needs.add("time")
                return _block("wait", inputs=self._inputs(N=args[0]))
            if method == "append":
                return _block("add_to", inputs=self._inputs(X=args[0], LIST=target))
            if method == "pop":
                return _block("remove_item", inputs=self._inputs(N=args[0], LIST=target))
        return self._call("method", call)

    def _assign(self, node: ast.Assign) -> dict | None:
        if len(node.targets) != 1:
            return None
        target = node.targets[0]
        if isinstance(target, ast.Name) and is_name(target.id):
            return _block("set", fields={"VAR": target.id}, inputs=self._inputs(VALUE=node.value))
        if isinstance(target, ast.Subscript) and not isinstance(target.slice, (ast.Slice, ast.Tuple)):
            return _block("set_item", inputs=self._inputs(N=target.slice, LIST=target.value, X=node.value))
        return None

    def _for(self, node: ast.For) -> dict | None:
        if node.orelse or not isinstance(node.target, ast.Name) or not is_name(node.target.id):
            return None
        var, it = node.target.id, node.iter
        body = self._body_of(node)
        is_range = (isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range"
                    and not it.keywords and 1 <= len(it.args) <= 3
                    and not any(isinstance(a, ast.Starred) for a in it.args))
        if not is_range:
            return _block("for_each", fields={"VAR": var}, inputs={**self._inputs(LIST=it), **body})
        args = it.args
        if len(args) == 1 and var == "_":
            return _block("repeat", inputs={**self._inputs(N=args[0]), **body})
        if len(args) == 1:
            return _block("count", fields={"VAR": var}, inputs={**self._inputs(B=args[0]), **body})
        if len(args) == 2:
            return _block("count", fields={"VAR": var},
                          inputs={**self._inputs(optional={"A"}, A=args[0], B=args[1]), **body})
        return _block("count_by", fields={"VAR": var},
                      inputs={**self._inputs(optional={"A"}, A=args[0], B=args[1], S=args[2]), **body})

    def _while(self, node: ast.While) -> dict | None:
        if node.orelse:
            return None
        body, test = self._body_of(node), node.test
        if isinstance(test, ast.Constant) and test.value is True:
            return _block("forever", inputs=body)
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            return _block("until", inputs={**self._inputs(COND=test.operand), **body})
        return _block("while", inputs={**self._inputs(COND=test), **body})

    def _if(self, node: ast.If) -> dict:
        branches = [node]
        while self._is_elif(branches[-1]):
            branches.append(branches[-1].orelse[0])
        last = branches[-1]
        inputs = {}
        for i, branch in enumerate(branches):
            inputs.update(self._inputs(**{f"IF{i}": branch.test}))
            if i + 1 < len(branches):  # comments before the next `elif` are this branch's, however indented
                limit, any_column = branches[i + 1].lineno - 1, True
            elif last.orelse:
                limit, any_column = self._else_row(last.orelse) - 1, True
            else:
                limit, any_column = self._next_code_row(branch.end_lineno) - 1, False
            inputs.update(self._body(f"DO{i}", branch.body, self._header_end(branch), limit, any_column))
        if last.orelse:
            inputs.update(self._body("ELSE", last.orelse, self._else_row(last.orelse),
                                     self._next_code_row(last.end_lineno) - 1))
        return _block("if", extra={"elifs": len(branches) - 1, "else": bool(last.orelse)}, inputs=inputs)

    def _body_of(self, node: ast.stmt) -> dict:
        """The body of a for, while or def."""
        return self._body("DO", node.body, self._header_end(node), self._next_code_row(node.end_lineno) - 1)

    def _body(self, name: str, nodes: list[ast.stmt], anchor: int, limit: int, any_column: bool = False) -> dict:
        """A C-shaped input: its statements chained. A body that is only a bare `pass` is an empty input, which is
        what the generator writes as `pass`."""
        blocks = [block for block, _ in self._statements(nodes, anchor, limit, any_column=any_column)]
        if len(blocks) == 1 and _is_bare_pass(blocks[0]):
            return {}
        return {name: {"block": _chain(blocks)}}

    # -- calls ---------------------------------------------------------------------------------------------------

    def _awkward_call(self, call: ast.Call) -> bool:
        """`f(*a)`, `f(**k)` and `sum(x for x in xs)` have no block (the last because it shares its brackets)."""
        if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
            return True
        return len(call.args) == 1 and not call.keywords and isinstance(call.args[0], ast.GeneratorExp)

    def _items(self, kind: str, items: list[ast.expr]) -> dict:
        inputs = self._inputs(**{f"ARG{i}": item for i, item in enumerate(items)})
        return _block(kind, extra={"items": len(items)}, inputs=inputs)

    def _own(self, kind: str, name: str, items: list[ast.expr]) -> dict:
        """A call of a function the program makes: its own block (a named block wins, BF-D-011)."""
        inputs = self._inputs(**{f"ARG{i}": item for i, item in enumerate(items)})
        return _block(kind, fields={"NAME": name}, extra={"args": len(items)}, inputs=inputs)

    def _call(self, kind: str, call: ast.Call) -> dict | None:
        """The general call blocks: `name(a, k=v)` and `x.name(a, k=v)`."""
        func = call.func
        if isinstance(func, ast.Name):
            name, target = func.id, None
        elif isinstance(func, ast.Attribute):
            name, target = func.attr, func.value
        else:
            return None
        if not is_name(name) or not all(is_name(k.arg) for k in call.keywords):
            return None
        parts = [(None, a) for a in call.args] + [(k.arg, k.value) for k in call.keywords]
        fields = {"NAME": name, **{f"KW{i}": key for i, (key, _) in enumerate(parts) if key is not None}}
        inputs = {}
        if target is not None:
            if isinstance(target, ast.Name) and target.id in IMPORT_ORDER:
                self.needs.add(target.id)
            inputs.update(self._inputs(OBJ=target))
        inputs.update(self._inputs(**{f"ARG{i}": value for i, (_, value) in enumerate(parts)}))
        extra = {"args": ["k" if key is not None else "p" for key, _ in parts]}
        return _block(kind, fields=fields, extra=extra, inputs=inputs)

    # -- values --------------------------------------------------------------------------------------------------

    def _inputs(self, optional: frozenset[str] | set[str] = frozenset(), **slots: ast.expr | None) -> dict:
        """The value inputs of a block. `None` in Python is an empty slot, which the generator writes as `None`; in
        an optional slot (one the generator leaves out when empty) it is Python code."""
        inputs = {}
        for name, node in slots.items():
            if node is None or (isinstance(node, ast.Constant) and node.value is None and name not in optional):
                continue
            inputs[name] = _slot(self._value(node))
        return inputs

    def _value(self, node: ast.expr) -> dict:
        block = self._value_block(node)
        return block if block is not None else self._code_value(node)

    def _code_value(self, node: ast.expr) -> dict:
        """A "Python code" value: its exact text, and how tightly it binds so it is bracketed only as needed."""
        # Its later lines lose the statement's indentation, which the generator puts back (as for a statement).
        rows = _NEWLINE.split(ast.get_source_segment(self.source, node))
        text = "\n".join([rows[0]] + [row[len(self.indent):] if row.startswith(self.indent) else row for row in rows[1:]])
        if len(rows) > 1 and not _parses_alone(text):
            # Its line breaks were inside brackets around it (`(a |` / `b)`, strings side by side), which the
            # expression's own text leaves out: it keeps a pair, so it still reads as one value. Brackets change nothing
            # Python reads; the text may gain them where they were written further away (a tidy, BF-D-012).
            return _block("code_value", fields={"TEXT": "(" + text + ")"}, extra={"order": "ATOMIC"})
        return _block("code_value", fields={"TEXT": text}, extra={"order": self._order(node, text)})

    @staticmethod
    def _order(node: ast.expr, text: str) -> str:
        if isinstance(node, ast.BinOp):
            return _ORDER_OF_OPERATOR[type(node.op)]
        if isinstance(node, ast.UnaryOp):
            return "NOT" if isinstance(node.op, ast.Not) else "UNARY"
        if isinstance(node, ast.BoolOp):
            return "AND" if isinstance(node.op, ast.And) else "OR"
        if isinstance(node, ast.Compare):
            return "RELATIONAL"
        if isinstance(node, ast.IfExp):
            return "CONDITIONAL"
        if isinstance(node, ast.Await):
            return "AWAIT"
        if isinstance(node, (ast.Attribute, ast.Subscript, ast.Call)):
            return "CALL"
        if isinstance(node, (ast.Lambda, ast.NamedExpr, ast.Yield, ast.YieldFrom, ast.Starred)):
            return "LOWEST"
        if isinstance(node, ast.Tuple) and not text.startswith("("):
            return "LOWEST"
        return "ATOMIC"  # names, literals, f-strings, anything in brackets of its own

    def _value_block(self, node: ast.expr) -> dict | None:
        if isinstance(node, ast.Constant):
            return self._constant(node)
        if isinstance(node, ast.Name):
            return _block("variable", fields={"VAR": node.id}) if is_name(node.id) else None
        if isinstance(node, ast.BinOp):
            op = type(node.op)
            if op in _ARITH:
                return _block("arith", fields={"OP": _ARITH[op]}, inputs=self._inputs(A=node.left, B=node.right))
            if op in _BINARY_BLOCK:
                return _block(_BINARY_BLOCK[op], inputs=self._inputs(A=node.left, B=node.right))
            return None
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.USub):
                return self._negative_number(node) or _block("negate", inputs=self._inputs(X=node.operand))
            if isinstance(node.op, ast.Not):
                return _block("not", inputs=self._inputs(X=node.operand))
            return None
        if isinstance(node, ast.BoolOp):
            # a and b and c is (a and b) and c, which the generator writes with no brackets
            op = "and" if isinstance(node.op, ast.And) else "or"
            block = None
            for right in node.values[1:]:
                left = {"A": {"block": block}} if block else self._inputs(A=node.values[0])
                block = _block("logic", fields={"OP": op}, inputs={**left, **self._inputs(B=right)})
            return block
        if isinstance(node, ast.Compare):
            if len(node.ops) != 1:
                return None
            op = type(node.ops[0])
            if op in _COMPARE:
                return _block("compare", fields={"OP": _COMPARE[op]},
                              inputs=self._inputs(A=node.left, B=node.comparators[0]))
            if op is ast.In:
                return _block("contains", inputs=self._inputs(LIST=node.comparators[0], X=node.left))
            return None
        if isinstance(node, ast.Call):
            return self._call_value(node)
        if isinstance(node, ast.Subscript):
            if isinstance(node.slice, (ast.Slice, ast.Tuple)):
                return None
            return _block("item_at", inputs=self._inputs(N=node.slice, LIST=node.value))
        if isinstance(node, ast.List):
            if any(isinstance(e, ast.Starred) for e in node.elts):
                return None
            return self._items("list_of", node.elts) if node.elts else _block("empty_list")
        if (self.funground and isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                and node.value.id == "f" and node.attr in _SKETCH_VALUES):
            self.needs.add("funground")
            return _block("sketch_value", fields={"WHAT": node.attr})
        return None

    def _constant(self, node: ast.Constant) -> dict | None:
        value = node.value
        if isinstance(value, bool):
            return _block("boolean", fields={"VALUE": "True" if value else "False"})
        if isinstance(value, str):
            return _block("text", fields={"TEXT": value})
        if isinstance(value, (int, float)):
            text = ast.get_source_segment(self.source, node)
            return _block("number", fields={"NUM": text}) if _NUMBER.match(text) else None
        return None  # None, bytes, complex, ...: Python code

    def _negative_number(self, node: ast.UnaryOp) -> dict | None:
        """`-5` is the number -5, as typed in a number slot (not "minus 5")."""
        operand = node.operand
        if isinstance(operand, ast.Constant) and type(operand.value) in (int, float):
            text = ast.get_source_segment(self.source, operand)
            if _NUMBER.match(text):
                return _block("number", fields={"NUM": "-" + text})
        return None

    def _call_value(self, call: ast.Call) -> dict | None:
        if self._awkward_call(call):
            return None
        func, args = call.func, call.args
        if not call.keywords:
            if isinstance(func, ast.Name):
                if func.id == "input" and len(args) <= 1:
                    return _block("ask", inputs=self._inputs(optional={"Q"}, Q=args[0] if args else None))
                if func.id in _CALL1 and len(args) == 1:
                    return _block(_CALL1[func.id], inputs=self._inputs(X=args[0]))
                if func.id in self.own_functions:
                    return self._own("own_call_value", func.id, args)
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                module, name = func.value.id, func.attr
                if (module, name, len(args)) == ("random", "randint", 2):
                    self.needs.add("random")
                    return _block("randint", inputs=self._inputs(A=args[0], B=args[1]))
                if (module, name, len(args)) == ("math", "sqrt", 1):
                    self.needs.add("math")
                    return _block("sqrt", inputs=self._inputs(X=args[0]))
        return self._call("call_value" if isinstance(func, ast.Name) else "method_value", call)
