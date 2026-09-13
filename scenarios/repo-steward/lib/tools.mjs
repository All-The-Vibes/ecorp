import { createSteward } from './steward.mjs';
import { integer, isObject, loadPolicy, requireThat } from './common.mjs';

const numberSchema = { type: 'object', properties: { number: { type: 'integer', minimum: 1, maximum: 100000000 } }, required: ['number'], additionalProperties: false };
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
export const TOOL_CATALOG = Object.freeze([
  { name: 'steward_audit', description: 'Read the evidence-backed repository audit. Performs no changes.', inputSchema: emptySchema },
  { name: 'steward_issue', description: 'Explain one in-scope issue from the supplied snapshot; no ownership inference.', inputSchema: numberSchema },
  { name: 'steward_pull_request', description: 'Explain one PR, closing intent, reviews and checks from the supplied snapshot.', inputSchema: numberSchema },
  { name: 'steward_workstreams', description: 'List approved topic workstreams, not people or assignments.', inputSchema: emptySchema },
  { name: 'steward_question', description: 'Answer a bounded repository question or ask for clarification. Refuses mutation requests.', inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['question'], additionalProperties: false } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })));

// Model-facing tools receive a snapshot, never a GitHub client or credentials.
// This is an adapter-neutral tool catalogue, not a second MCP implementation.
export function createStewardTools(snapshot, options = {}) {
  const agent = createSteward(snapshot, options), policy = options.policy || loadPolicy();
  return Object.freeze({
    catalog: TOOL_CATALOG,
    call(name, args = {}) {
      const tool = TOOL_CATALOG.find(t => t.name === name);
      requireThat(tool && isObject(args), 'READ_ONLY', 'Unknown tool; mutation tools are not present.');
      const allowed = Object.keys(tool.inputSchema.properties);
      requireThat(Object.keys(args).every(key => allowed.includes(key)), 'TOOL_ARGUMENT', 'Unexpected tool argument.');
      for (const required of tool.inputSchema.required || []) requireThat(Object.hasOwn(args, required), 'TOOL_ARGUMENT', 'Required tool argument is missing.');
      if (allowed.includes('number')) requireThat(integer(args.number), 'TOOL_ARGUMENT', 'An in-scope issue or PR number is required.');
      if (name === 'steward_audit') return agent.report;
      if (name === 'steward_workstreams') return { workstreams: policy.workstreams.map(w => ({ id: w.id, name: w.name })), assignment_effect: 'none', executed_actions: [] };
      if (name === 'steward_issue') {
        requireThat(snapshot.issues.some(i => i.number === args.number), 'UNVERIFIED', 'Issue is not available in the scoped snapshot.');
        return agent.ask(`Explain issue #${args.number}`);
      }
      if (name === 'steward_pull_request') {
        requireThat(snapshot.pull_requests.some(i => i.number === args.number), 'UNVERIFIED', 'PR is not available in the scoped snapshot.');
        return agent.ask(`Explain PR #${args.number}`);
      }
      return agent.ask(args.question);
    },
  });
}
