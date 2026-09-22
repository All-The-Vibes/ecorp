import hashlib
import json
from pathlib import Path
import subprocess
import sys

product, qa = map(Path, sys.argv[1:3])
dependency = qa / "dependencies" / "pr237"
commit = "b31a38a62330aacba80c3953142e1da957a63ecd"
expected = "6d0bc7975f68c578a77ac3ebf54b7ee64e99871cfe964d5b9bf6afa2dd58cb1e"
assert not dependency.exists(), "Preserve an existing helper checkout."
dependency.parent.mkdir()
subprocess.run(["git", "-C", str(product), "-c", "core.autocrlf=false", "-c", "core.eol=lf",
                "worktree", "add", "--detach", str(dependency), commit], check=True, capture_output=True)
original = subprocess.check_output(["git", "-C", str(dependency), "show", f"{commit}:tools/owned_test_stack.mjs"])
helper = dependency / "tools" / "owned_test_stack.mjs"
helper.write_bytes(original)
patch = (product / "tools" / "issue161" / "pr237-native-time.patch").read_bytes().replace(b"\r\n", b"\n")
for extra in (["--check"], []):
    subprocess.run(["git", "-C", str(dependency), "-c", "core.autocrlf=false", "-c", "core.eol=lf",
                    "apply", *extra, "-"], input=patch, check=True, capture_output=True)
actual = hashlib.sha256(helper.read_bytes()).hexdigest()
assert actual == expected, actual
status = subprocess.check_output(["git", "-C", str(dependency), "status", "--porcelain"]).decode().strip()
assert status == "M tools/owned_test_stack.mjs", status
receipt = {
    "base_commit": commit, "base_path": "tools/owned_test_stack.mjs",
    "base_sha256": hashlib.sha256(original).hexdigest(),
    "patch_path": "tools/issue161/pr237-native-time.patch",
    "patch_lf_sha256": hashlib.sha256(patch).hexdigest(),
    "output_sha256": actual, "dependency_status": status,
    "historical_runtime_binding_claimed": False,
}
(qa / "helper-reconstruction.json").write_bytes((json.dumps(receipt, indent=2) + "\n").encode())
print(json.dumps(receipt))
