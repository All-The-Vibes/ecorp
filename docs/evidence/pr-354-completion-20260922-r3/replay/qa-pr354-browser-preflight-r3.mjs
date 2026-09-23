import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReplaySource } from '../../../../tools/check_replay_source.mjs';

const forbidden = Object.keys(process.env).filter(name => /^(PG|DATABASE_URL$|GH_|GITHUB_|AZURE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|COPILOT_GITHUB_TOKEN$)/i.test(name));
assert.deepEqual(forbidden, [], 'Browser execution must not inherit database or vendor credential variables, including file locators');
assert.equal(process.env.ECORP_COMPLETION_PR, '354');
const product = process.env.ECORP_COMPLETION_PRODUCT;
const root = process.env.ECORP_COMPLETION_QA_ROOT;
assert.ok(path.isAbsolute(product ?? '') && path.isAbsolute(root ?? ''), 'Explicit absolute product and fixture roots are required');
const binding = verifyReplaySource(product, process.env.ECORP_COMPLETION_VALIDATION_DIRECTORY, 354);
const ownership = JSON.parse(readFileSync(path.join(root, 'ownership.json'), 'utf8'));
const setup = JSON.parse(readFileSync(process.env.ECORP_POLICY_SETUP, 'utf8'));
assert.equal(ownership.test_owned, true);
assert.equal(ownership.purpose, 'pr265-run-activity');
assert.equal(setup.test_owned, true);
assert.equal(realpathSync(ownership.workspace), realpathSync(root));
assert.equal(realpathSync(setup.qa_root), realpathSync(root));
assert.equal(realpathSync(ownership.plan.product), realpathSync(product));
assert.equal(ownership.plan.product_commit, binding.source_head);
assert.equal(setup.tested_staged_tree, binding.tested_staged_tree);
assert.equal(setup.server_url, ownership.plan.server);
assert.equal(setup.web_url, ownership.plan.web);
assert.deepEqual(setup.processes, ownership.processes);
// The caller's native supervisor verifies creation time, binary, workspace and
// listener ownership immediately before this child. The browser driver repeats
// native server ownership admission before issuing product requests.
console.log(JSON.stringify({check:'browser-source-and-credential-preflight',status:'passed',forbidden_variable_names:forbidden,...binding}));
await import(pathToFileURL(path.join(product, 'tools/e2e_verification_policy_browser.mjs')).href);
