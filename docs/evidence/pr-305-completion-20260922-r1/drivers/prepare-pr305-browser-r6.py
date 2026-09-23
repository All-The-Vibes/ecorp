from pathlib import Path

base = Path(__file__).resolve().parent
source = (base / "run-pr305-browser-r5.ps1").read_bytes().decode()
source = source.replace("pr305-20260922-browser-r5", "pr305-20260922-browser-r6")
source = source.replace("$prefix='pr305-browser-r5'", "$prefix='pr305-browser-r6'")
destination = base / "run-pr305-browser-r6.ps1"
with destination.open("xb") as handle:
    handle.write(source.encode())
print(destination)
