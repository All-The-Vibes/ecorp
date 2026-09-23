"""Retain and correct the unapplied candidate helper for the observed feedback schema."""
import ast
import hashlib
import json
from pathlib import Path

private = Path(__file__).resolve().parent
source = private / 'apply-queue-pr319-r482.py'
target = private / 'apply-queue-pr319-r483.py'
receipt = private / 'queue-application-binding-r483.json'
if target.exists() or receipt.exists():
    raise SystemExit('Preserve the prior helper preparation.')
feedback_path = private / 'pr-feedback-queue-pr319-r474.json'
observed = json.loads(feedback_path.read_text(encoding='utf-8-sig'))
if not isinstance(observed, dict) or observed.get('number') != 319 or observed['data']['headRefOid'] != 'f1a5e50736867b9e2321cb4f642f0f93395b6218':
    raise SystemExit('The inspected single-PR feedback shape changed.')
text = source.read_text(encoding='utf-8-sig').replace('r482', 'r483')
needle = 'latest_feedback = read(private / "pr-feedback-queue-pr319-r474.json")\n'
if text.count(needle) != 1:
    raise SystemExit('Unexpected feedback boundary.')
text = text.replace(needle, needle + 'if isinstance(latest_feedback, dict):\n    latest_feedback = [latest_feedback]\n')
ast.parse(text)
target.write_text(text, encoding='utf-8', newline='\n')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
receipt.write_text(json.dumps({'status': 'prepared-not-executed', 'original': source.name,
    'original_sha256': sha(source), 'helper': target.name, 'helper_sha256': sha(target),
    'feedback_sha256': sha(feedback_path),
    'correction': 'The observed feedback is one object, not a one-element list. Normalize only that envelope while preserving the PR number and exact head checks. No source is applied by this preparation.'}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': 'prepared-not-executed', 'helper': str(target)}))
