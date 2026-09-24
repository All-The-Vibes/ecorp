import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const forbidden = Object.keys(process.env).filter(name => /^(PG|DATABASE_URL$|GH_|GITHUB_|AZURE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|COPILOT_GITHUB_TOKEN$)/i.test(name));
assert.deepEqual(forbidden, [], 'Browser execution must not inherit database or vendor credential variables, including file locators');
assert.equal(process.env.ECORP_COMPLETION_PR, '355');
assert.ok(path.isAbsolute(process.env.ECORP_COMPLETION_PRODUCT ?? ''), 'An explicit absolute reviewed checkout is required');
console.log(JSON.stringify({check:'browser-credential-preflight',status:'passed',forbidden_variable_names:forbidden}));
await import(pathToFileURL(path.join(process.env.ECORP_COMPLETION_PRODUCT, 'tools/e2e_verification_policy_browser.mjs')).href);
