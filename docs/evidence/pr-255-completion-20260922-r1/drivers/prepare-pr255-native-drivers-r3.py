import hashlib
import json
import shutil
from pathlib import Path

base = Path(__file__).resolve().parent
source = base / "pr255-native-r1-drivers"
target = base / "pr255-native-r3-drivers"
assert not target.exists()
shutil.copytree(source, target)
host = target / "qa-host.ps1"
text = host.read_bytes().decode()
old = "--pwfile=(Join-Path $qa 'secrets/pg-password.txt')"
assert text.count(old) == 1
text = text.replace(old, "('--pwfile='+(Join-Path $qa 'secrets/pg-password.txt'))")
host.write_bytes(text.encode())
derivation = json.loads((target / "derivation.json").read_bytes())
for item in derivation["files"]:
    item["executed_sha256"] = hashlib.sha256((target / item["executed_copy"]).read_bytes()).hexdigest()
derivation["r3_correction"] = "Pass initdb's --pwfile= value as one PowerShell argument. Preserve failed r1/r2 records and r1 executed scripts unchanged."
(target / "derivation.json").write_bytes((json.dumps(derivation, indent=2) + "\n").encode())
print(json.dumps({"driver_directory": str(target)}))
