"""Preserve r1 and prepare r2 with typed CSS-design-token classification."""
from issue264_publication_lib_r1 import *
import ast

receipt = EV / "issue264-publication-redaction-regressions-r1.json"
assert not receipt.exists()
assert not PACKET.exists()
source = load(EV / "issue264-completion-source-r1.json")
original_files(source["physical_files"])
pending_merge()
assert index_digest() == source["original_index_sha256"]

classifier = '''css_design_tokens = set(re.findall(r"(--[-a-z0-9]+)\\s*:", (ROOT/"apps/web/src/ConsoleTheme.css").read_text(encoding="utf-8")))

def is_secret_field(container, key, child):
    if not secret_key.fullmatch(key) or not isinstance(child, str) or not child:
        return False
    # These two exact measurement schemas use token for a defined CSS property.
    # Other token fields, even with a CSS-looking value, remain credential-bearing.
    if key == "token" and child in css_design_tokens and set(container) in (
        {"state", "token", "color", "contrast"},
        {"selector", "token", "expected", "observed"},
    ):
        return False
    return True
'''

names = ["assemble", "validate", "commit", "scan"]
prepared = {}
for name in names:
    old = EV / f"{name}-issue264-completion-r1.py"
    new = EV / f"{name}-issue264-completion-r2.py"
    assert not new.exists()
    text = old.read_text(encoding="utf-8-sig")
    text = re.sub(r"issue264-completion-(source|packet|self-review|feedback-resolution|visual-resolution|evidence-validation|validation|commit|secret-scan)-r1", r"issue264-completion-\1-r2", text)
    text = text.replace("-issue264-completion-r1.py", "-issue264-completion-r2.py")
    if name == "assemble":
        before = 'secrets, redactions = set(), []'
        assert text.count(before) == 1
        text = text.replace(before, classifier + "\n" + before)
        before = 'if secret_key.fullmatch(key) and isinstance(child, str) and child:'
        assert text.count(before) == 1
        text = text.replace(before, 'if is_secret_field(value, key, child):')
        before = 'secret_key.fullmatch(k) and isinstance(v, str) and v else scrub(v)'
        assert text.count(before) == 1
        text = text.replace(before, 'is_secret_field(value, k, v) else scrub(v)')
        before = 'copies += [(EV/name, "drivers/"+name) for name in sorted(driver_names)]'
        assert text.count(before) == 1
        text = text.replace(before, 'driver_names.add("repair-issue264-evidence-classifier-r1.py")\n' + before + '\ncopies += [(EV/"issue264-publication-redaction-regressions-r1.json", "history/redaction-regressions.json"), (EV/"issue264-completion-packet-r1-failure.json", "history/assembly-r1-failure.json")]')
    ast.parse(text, filename=new.name)
    prepared[new] = text

# Execute the actual r2 classification and redaction functions with synthetic
# credential canaries; no private credential values are printed or recorded.
tree = ast.parse(prepared[EV / "assemble-issue264-completion-r2.py"])
selected = []
variables = {"secret_key", "css_design_tokens", "secrets", "redactions", "personal"}
functions = {"is_secret_field", "discover", "redact_text", "scrub"}
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in functions:
        selected.append(node)
    elif isinstance(node, ast.Assign):
        ids = {n.id for target in node.targets for n in ast.walk(target) if isinstance(n, ast.Name)}
        if ids & variables:
            selected.append(node)
scope = {"re": re, "ROOT": ROOT}
exec(compile(ast.Module(body=selected, type_ignores=[]), "actual-r2-redactor", "exec"), scope)
css = "--theme-canvas"
assert css in scope["css_design_tokens"]
cases = [
    ({"token": "redaction-canary"}, True),
    ({"token": css}, True),
    ({"api_key": css}, True),
    ({"state": "ok", "token": css, "color": "rgb(0, 0, 0)", "contrast": 21}, False),
    ({"selector": ".office", "token": css, "expected": "rgb(0, 0, 0)", "observed": "rgb(0, 0, 0)"}, False),
    ({"state": "ok", "token": "redaction-canary", "color": "rgb(0, 0, 0)", "contrast": 21}, True),
    ({"state": "ok", "token": css, "color": "rgb(0, 0, 0)", "contrast": 21, "scope": "auth"}, True),
    ({"token": ""}, False),
]
for container, expected in cases:
    key = "api_key" if "api_key" in container else "token"
    assert scope["is_secret_field"](container, key, container[key]) is expected
    scope["secrets"].clear()
    scope["redactions"].clear()
    scope["discover"](container, "$", "synthetic")
    observed = scope["scrub"](container)
    assert observed[key] == ("<REDACTED>" if expected else container[key])
scope["secrets"].clear()
scope["redactions"].clear()
for path, text in prepared.items():
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
write(receipt, {"status": "passed", "recorded_at_utc": now(), "cases": len(cases),
                "scope": "Actual r2 redaction functions; synthetic secret canaries and exact CSS measurement schemas. Application source and canonical check inputs are unchanged.",
                "classification": "Only exact viewport/native color-measurement schemas whose token value names a property defined in the reviewed ConsoleTheme.css are exempt. All other credential classification and residual/secret-scan assertions remain enabled.",
                "scripts": [{"name": p.name, "sha256": sha(p.read_bytes())} for p in prepared],
                "source_receipt": "issue264-completion-source-r1.json", "original_index_unchanged": index_digest() == source["original_index_sha256"]})
print(json.dumps({"status": "prepared-r2", "redaction_cases_passed": len(cases), "original_source_unchanged": True}))
