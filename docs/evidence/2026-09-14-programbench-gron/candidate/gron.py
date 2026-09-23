#!/usr/bin/python3
import decimal
import errno
import json
import math
import os
import re
import ssl
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


HELP = """Transform JSON (from a file, URL, or stdin) into discrete assignments to make it greppable

Usage:
  gron [OPTIONS] [FILE|URL|-]

Options:
  -u, --ungron     Reverse the operation (turn assignments back into JSON)
  -v, --values     Print just the values of provided assignments
  -c, --colorize   Colorize output (default on tty)
  -m, --monochrome Monochrome (don't colorize output)
  -s, --stream     Treat each line of input as a separate JSON object
  -k, --insecure   Disable certificate validation
  -x, --proxy      Set proxy configuration
      --noproxy    Comma-separated list of hosts for which not to use a proxy, if one is specified.
  -j, --json       Represent gron data as JSON stream
      --no-sort    Don't sort output (faster)
      --version    Print version information

Exit Codes:
  0\tOK
  1\tFailed to open file
  2\tFailed to read input
  3\tFailed to form statements
  4\tFailed to fetch URL
  5\tFailed to parse statements
  6\tFailed to encode JSON

Examples:
  gron /tmp/apiresponse.json
  gron http://jsonplaceholder.typicode.com/users/1 
  curl -s http://jsonplaceholder.typicode.com/users/1 | gron
  gron http://jsonplaceholder.typicode.com/users/1 | grep company | gron --ungron
"""

RESERVED = set("break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield".split())


class Failure(Exception):
    def __init__(self, message, code=5):
        self.message = message
        self.code = code


class JSONFailure(Exception):
    pass


class Number(str):
    pass


def quote(value):
    return json.dumps(value, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def gochar(character):
    escapes = {"\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f", "\\": "\\\\", "'": "\\'"}
    if character in escapes:
        character = escapes[character]
    elif ord(character) < 32 or ord(character) == 127:
        character = "\\x%02x" % ord(character)
    return "'" + character + "'"


def normalize_surrogates(value):
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


class Decoder:
    def __init__(self, text, strict=False, floats=False):
        self.text = text
        self.index = 0
        self.strict = strict
        self.floats = floats

    def eof(self):
        raise JSONFailure("unexpected end of JSON input" if self.strict else "unexpected EOF")

    def peek(self):
        if self.index >= len(self.text):
            self.eof()
        return self.text[self.index]

    def space(self):
        while self.index < len(self.text) and self.text[self.index] in " \t\r\n":
            self.index += 1

    def invalid(self, character, context):
        raise JSONFailure("invalid character " + gochar(character) + " " + context)

    def string(self):
        start = self.index
        self.index += 1
        while True:
            character = self.peek()
            self.index += 1
            if character == '"':
                return normalize_surrogates(json.loads(self.text[start:self.index]))
            if character == "\\":
                escaped = self.peek()
                self.index += 1
                if escaped == "u":
                    for unused in range(4):
                        digit = self.peek()
                        self.index += 1
                        if digit not in "0123456789abcdefABCDEF":
                            self.invalid(digit, "in \\u hexadecimal character escape")
                elif escaped not in '"\\/bfnrt':
                    self.invalid(escaped, "in string escape code")
            elif ord(character) < 32:
                self.invalid(character, "in string literal")

    def number(self):
        start = self.index
        if self.peek() == "-":
            self.index += 1
            if self.peek() not in "0123456789":
                self.invalid(self.peek(), "in numeric literal")
        if self.peek() == "0":
            self.index += 1
        else:
            while self.index < len(self.text) and self.text[self.index] in "0123456789":
                self.index += 1
        if self.index < len(self.text) and self.text[self.index] == ".":
            self.index += 1
            if self.peek() not in "0123456789":
                self.invalid(self.peek(), "after decimal point in numeric literal")
            while self.index < len(self.text) and self.text[self.index] in "0123456789":
                self.index += 1
        if self.index < len(self.text) and self.text[self.index] in "eE":
            self.index += 1
            if self.peek() in "+-":
                self.index += 1
            if self.peek() not in "0123456789":
                self.invalid(self.peek(), "in exponent of numeric literal")
            while self.index < len(self.text) and self.text[self.index] in "0123456789":
                self.index += 1
        result = Number(self.text[start:self.index])
        if self.floats:
            result = float(result)
            if not math.isfinite(result):
                raise JSONFailure("json: cannot unmarshal number " + self.text[start:self.index] + " into Go value of type float64")
        return result

    def value(self, depth=0):
        if depth > 10000:
            self.invalid(self.peek(), "exceeded max depth")
        self.space()
        character = self.peek()
        if character == '"':
            return self.string()
        if character == "-" or character in "0123456789":
            return self.number()
        if character in "ntf":
            literal, result = {"n": ("null", None), "t": ("true", True), "f": ("false", False)}[character]
            for expected in literal:
                current = self.peek()
                if current != expected:
                    self.invalid(current, "in literal " + literal + " (expecting " + gochar(expected) + ")")
                self.index += 1
            return result
        if character == "[":
            self.index += 1
            self.space()
            result = []
            if self.peek() == "]":
                self.index += 1
                return result
            while True:
                result.append(self.value(depth + 1))
                self.space()
                current = self.peek()
                self.index += 1
                if current == "]":
                    return result
                if current != ",":
                    self.invalid(current, "after array element")
        if character == "{":
            self.index += 1
            self.space()
            result = {}
            if self.peek() == "}":
                self.index += 1
                return result
            while True:
                self.space()
                current = self.peek()
                if current != '"':
                    self.invalid(current, "looking for beginning of object key string")
                key = self.string()
                self.space()
                current = self.peek()
                self.index += 1
                if current != ":":
                    self.invalid(current, "after object key")
                result[key] = self.value(depth + 1)
                self.space()
                current = self.peek()
                self.index += 1
                if current == "}":
                    return result
                if current != ",":
                    self.invalid(current, "after object key:value pair")
        self.invalid(character, "looking for beginning of value")

    def decode(self):
        self.space()
        if self.index == len(self.text):
            if self.strict:
                self.eof()
            raise JSONFailure("EOF")
        result = self.value()
        if self.strict:
            self.space()
            if self.index != len(self.text):
                self.invalid(self.text[self.index], "after top-level value")
        return result


def float_text(value):
    if value == 0:
        return "-0" if math.copysign(1, value) < 0 else "0"
    text = repr(value)
    if 1e-6 <= abs(value) < 1e21:
        text = format(decimal.Decimal(text), "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text
    if "e" in text:
        mantissa, exponent = text.split("e")
        if mantissa.endswith(".0"):
            mantissa = mantissa[:-2]
        return mantissa + "e" + ("+" if int(exponent) >= 0 else "-") + str(abs(int(exponent)))
    return text.removesuffix(".0")


def encode(value, pretty=False, level=0):
    if isinstance(value, Number):
        return str(value)
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return quote(value)
    if isinstance(value, float):
        return float_text(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, dict):
        opening, closing = "{", "}"
        items = [quote(key) + (": " if pretty else ":") + encode(value[key], pretty, level + 1) for key in sorted(value)]
    else:
        opening, closing = "[", "]"
        items = [encode(item, pretty, level + 1) for item in value]
    if not items:
        return opening + closing
    if pretty:
        indent = "  " * (level + 1)
        return opening + "\n" + indent + (",\n" + indent).join(items) + "\n" + "  " * level + closing
    return opening + ",".join(items) + closing


def identifier_start(character):
    return character in "_$" or unicodedata.category(character) in ("Lu", "Ll", "Lt", "Lm", "Lo", "Nl")


def identifier_rest(character):
    return identifier_start(character) or unicodedata.category(character) in ("Mn", "Mc", "Nd", "Pc")


def valid_identifier(key):
    return bool(key) and key not in RESERVED and identifier_start(key[0]) and all(identifier_rest(character) for character in key[1:])


def segment(key):
    if isinstance(key, (int, float, Number)) and not isinstance(key, bool):
        return "[" + encode(key) + "]"
    return "." + key if valid_identifier(key) else "[" + quote(key) + "]"


def path_text(path):
    return "json" + "".join(segment(key) for key in path)


def flatten(value, path=(), sort=True):
    if isinstance(value, dict):
        yield path, {}
        keys = sorted(value, key=segment) if sort else value
        for key in keys:
            yield from flatten(value[key], path + (key,), sort)
    elif isinstance(value, list):
        yield path, []
        for index, child in enumerate(value):
            yield from flatten(child, path + (index,), sort)
    else:
        yield path, value


def emit_statements(statements, json_mode=False):
    for path, value in statements:
        if json_mode:
            print("[" + encode(list(path)) + "," + encode(value) + "]")
        else:
            print(path_text(path) + " = " + encode(value) + ";")


def fail_statement(text, error):
    raise Failure("ungron failed for `" + text + "`: " + error)


def parse_statement(line):
    if not line:
        return None
    index = 0
    keys = []
    if line[0] == " ":
        return None
    if identifier_start(line[0]):
        index = 1
        while index < len(line) and identifier_rest(line[index]):
            index += 1
        root = line[:index]
        if root != "json":
            keys.append(root)
    elif line[0] not in ".[":
        fail_statement("", "invalid statement")
    while index < len(line):
        character = line[index]
        if character == ".":
            index += 1
            start = index
            if index == len(line) or not identifier_start(line[index]):
                fail_statement(line[:index], "invalid statement")
            index += 1
            while index < len(line) and identifier_rest(line[index]):
                index += 1
            keys.append(line[start:index])
        elif character == "[":
            index += 1
            start = index
            if index < len(line) and line[index] == '"':
                decoder = Decoder(line[index:])
                try:
                    key = decoder.string()
                except (JSONFailure, ValueError):
                    fail_statement(line[:index], "invalid statement")
                index += decoder.index
            elif index < len(line) and line[index] in "0123456789":
                while index < len(line) and line[index] in "0123456789":
                    index += 1
                key = int(line[start:index])
                if key > 9223372036854775807:
                    fail_statement(line, "invalid integer key `" + line[start:index] + "`")
            else:
                fail_statement(line[:index], "invalid statement")
            if index == len(line) or line[index] != "]":
                fail_statement(line[:index], "invalid statement")
            index += 1
            keys.append(key)
        else:
            break
    path_end = index
    while index < len(line) and line[index] == " ":
        index += 1
    if index == len(line):
        return None
    if line[index] != "=":
        if line[index] == "." and path_end != index:
            return None
        if line[index] == ";":
            fail_statement(line[:path_end], "invalid statement")
        fail_statement(line, "statement has no value")
    index += 1
    while index < len(line) and line[index] == " ":
        index += 1
    value_start = index
    if index < len(line) and line[index] in "{[":
        closing = "}" if line[index] == "{" else "]"
        if index + 1 >= len(line) or line[index + 1] != closing:
            fail_statement(line[:index + 1], "statement has no value")
    in_string = False
    escaped = False
    while index < len(line):
        character = line[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character == ";":
            raw = line[value_start:index].strip(" ")
            text = line[:index + 1]
            try:
                value = Decoder(raw).decode()
            except (JSONFailure, ValueError):
                fail_statement(text, "invalid value `" + raw + "`")
            return tuple(keys), value
        index += 1
    fail_statement(line, "statement has no value")


def merge(left, right):
    if isinstance(left, dict):
        if not isinstance(right, dict):
            raise Failure("failed to merge statements: cannot merge object with non-object")
        for key, value in right.items():
            left[key] = merge(left[key], value) if key in left else value
        return left
    if isinstance(left, list):
        if not isinstance(right, list):
            raise Failure("failed to merge statements: cannot merge array with non-array")
        if len(right) > len(left):
            left.extend([None] * (len(right) - len(left)))
        for index, value in enumerate(right):
            if value is not None:
                left[index] = merge(left[index], value)
        return left
    return right


def statement_tree(path, value):
    for key in reversed(path):
        if isinstance(key, int):
            if key < 0 or key > 10000000:
                raise Failure("invalid JSON layout")
            value = [None] * key + [value]
        else:
            value = {key: value}
    return value


def lines(data):
    parts = data.split("\n")
    if parts[-1] == "":
        parts.pop()
    for line in parts:
        yield line.removesuffix("\r")


def json_statement(line):
    try:
        value = Decoder(line, strict=True, floats=True).decode()
    except JSONFailure as error:
        raise Failure(str(error))
    if value is not None and not isinstance(value, list):
        kind = "object" if isinstance(value, dict) else "bool" if isinstance(value, bool) else "number" if isinstance(value, float) else "string"
        raise Failure("json: cannot unmarshal " + kind + " into Go value of type []interface {}")
    if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], list):
        raise Failure("invalid JSON layout")
    path, content = value
    if isinstance(content, (list, dict)) and content:
        raise Failure("invalid JSON layout")
    result_path = []
    for key in path:
        if isinstance(key, float):
            text = float_text(key)
            if not re.fullmatch("[0-9]+", text) or int(text) > 9223372036854775807:
                fail_statement(path_text(path) + " = " + encode(content) + ";", "invalid integer key `" + text + "`")
            result_path.append(int(text))
        elif isinstance(key, str):
            result_path.append(key)
        else:
            raise Failure("invalid JSON layout")
    return tuple(result_path), content


def ungron(data, options):
    result = None
    count = 0
    for line in lines(data):
        statement = json_statement(line) if options["json"] else parse_statement(line)
        if statement is None:
            continue
        path, value = statement
        tree = statement_tree(path, value)
        result = tree if count == 0 else merge(result, tree)
        count += 1
    if not count:
        raise Failure("no statements were parsed")
    print(encode(result, pretty=not options["colorize"]))


def values(data):
    for line in lines(data):
        if "=" not in line:
            continue
        try:
            statement = parse_statement(line if ";" in line else line + ";")
        except Failure:
            statement = None
        if line.startswith(" "):
            raise Failure("failed to parse '" + line + "' as gron statement")
        if statement is not None:
            value = statement[1]
            if isinstance(value, (list, dict)):
                continue
            print(str(value) if isinstance(value, str) else encode(value))
        elif "=" in line:
            raw = line.split("=", 1)[1].strip().split(";", 1)[0].strip()
            if raw and raw[0] not in '[{"':
                print(raw)


def parse_flags(arguments):
    aliases = {"u": "ungron", "v": "values", "c": "colorize", "m": "monochrome", "s": "stream", "k": "insecure", "x": "proxy", "j": "json"}
    booleans = set(aliases.values()) - {"proxy"} | {"no-sort", "version"}
    options = dict.fromkeys(booleans, False)
    options.update(proxy="", noproxy="")
    position = 0
    while position < len(arguments):
        argument = arguments[position]
        if argument == "--":
            position += 1
            break
        if not argument.startswith("-") or argument == "-":
            break
        raw = argument[2:] if argument.startswith("--") else argument[1:]
        if not raw or raw.startswith(("-", "=")):
            raise Failure("bad flag syntax: " + argument + "\n" + HELP.rstrip("\n"), 2)
        name, separator, value = raw.partition("=")
        key = aliases.get(name, name)
        if key not in options:
            if name in ("h", "help"):
                raise Failure(HELP.rstrip("\n"), 0)
            raise Failure("flag provided but not defined: -" + name + "\n" + HELP.rstrip("\n"), 2)
        if key in booleans:
            if not separator:
                value = "true"
            if value not in ("1", "t", "T", "TRUE", "true", "True", "0", "f", "F", "FALSE", "false", "False"):
                raise Failure("invalid boolean value " + quote(value) + " for -" + name + ": parse error\n" + HELP.rstrip("\n"), 2)
            options[key] = value in ("1", "t", "T", "TRUE", "true", "True")
        else:
            if not separator:
                position += 1
                if position == len(arguments):
                    raise Failure("flag needs an argument: -" + name + "\n" + HELP.rstrip("\n"), 2)
                value = arguments[position]
            options[key] = value
        position += 1
    return options, arguments[position:]


def fetch(url, options):
    context = ssl._create_unverified_context() if options["insecure"] else ssl.create_default_context()
    proxy = options["proxy"]
    hostname = urllib.parse.urlsplit(url).hostname or ""
    excluded = any(host == "*" or hostname == host.lstrip(".") or hostname.endswith("." + host.lstrip(".")) for host in options["noproxy"].split(",") if host)
    handlers = [urllib.request.HTTPSHandler(context=context)]
    if proxy and not excluded:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(url, headers={"User-Agent": "gron/dev"})
    try:
        with opener.open(request, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        return error.read()
    except (OSError, ValueError) as error:
        raise Failure("Get " + quote(url) + ": " + str(getattr(error, "reason", error)), 4)


def read_input(arguments, options):
    if not arguments or arguments[0] == "-":
        try:
            return sys.stdin.buffer.read()
        except OSError as error:
            raise Failure("read /dev/stdin: " + error.strerror.lower(), 2)
    filename = arguments[0]
    if filename.startswith(("http://", "https://")):
        return fetch(filename, options)
    try:
        with open(filename, "rb") as source:
            return source.read()
    except OSError as error:
        if error.errno == errno.EISDIR:
            raise Failure("read " + filename + ": is a directory", 2)
        raise Failure("open " + filename + ": " + error.strerror.lower(), 1)


def main():
    options, arguments = parse_flags(sys.argv[1:])
    if options["version"]:
        print("gron version dev")
        return
    data = read_input(arguments, options).decode("utf-8", "replace")
    if options["ungron"]:
        ungron(data, options)
    elif options["values"]:
        values(data)
    elif options["stream"]:
        emit_statements([((), [])], options["json"])
        for index, line in enumerate(lines(data)):
            try:
                value = Decoder(line).decode()
            except JSONFailure as error:
                raise Failure("failed to form statements: " + str(error), 3)
            emit_statements(flatten(value, (index,), not options["no-sort"]), options["json"])
    else:
        try:
            value = Decoder(data).decode()
        except JSONFailure as error:
            raise Failure("failed to form statements: " + str(error), 3)
        emit_statements(flatten(value, sort=not options["no-sort"]), options["json"])


if __name__ == "__main__":
    sys.setrecursionlimit(50000)
    try:
        main()
    except Failure as error:
        sys.stdout.flush()
        sys.stderr.write(error.message + "\n")
        sys.exit(error.code)
    except BrokenPipeError:
        os._exit(0)
