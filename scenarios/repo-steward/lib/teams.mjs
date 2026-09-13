import { createSteward } from './steward.mjs';
import { markdown, requireThat } from './common.mjs';

export function validateTestBinding(binding) {
  requireThat(binding && binding.mode === 'test-only', 'TEAMS_DISABLED', 'Only an explicitly configured test-chat binding is supported.');
  requireThat(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.tenantId || ''), 'TEAMS_TENANT', 'An exact test tenant ID is required.');
  requireThat(typeof binding.chatId === 'string' && /^19:[A-Za-z0-9_:@.\-]{5,250}$/.test(binding.chatId), 'TEAMS_CHAT', 'An exact test group-chat ID is required.');
  requireThat(typeof binding.botId === 'string' && /^[A-Za-z0-9:._-]{5,100}$/.test(binding.botId), 'TEAMS_BOT', 'An exact bot identity is required.');
  requireThat((!Object.hasOwn(binding, 'allowWrites') || binding.allowWrites === false) && !Object.hasOwn(binding, 'productionChatId'), 'READ_ONLY', 'Repository writes and production chat are not supported by this test binding.');
  return binding;
}

// Pure routing for an ALREADY AUTHENTICATED Teams SDK activity. This is not an
// HTTP endpoint and does not authenticate a request or send a Teams message.
// Never expose this helper directly as a public webhook.
export function prepareTestChatReply(activity, binding, snapshot, options = {}) {
  validateTestBinding(binding);
  requireThat(activity?.channelId === 'msteams' && activity?.type === 'message', 'TEAMS_EVENT', 'Only Teams message activities are supported.');
  requireThat(activity.channelData?.tenant?.id === binding.tenantId, 'TEAMS_TENANT', 'Activity does not belong to the approved test tenant.');
  requireThat(activity.conversation?.id === binding.chatId && activity.conversation?.conversationType === 'groupChat', 'TEAMS_CHAT', 'Activity is not from the approved test group chat.');
  requireThat(activity.recipient?.id === binding.botId, 'TEAMS_BOT', 'Activity recipient does not match the configured bot.');
  requireThat(typeof activity.id === 'string' && activity.id.length <= 256 && typeof activity.from?.id === 'string', 'TEAMS_EVENT', 'Message and sender identities are required.');
  if (activity.from.id === binding.botId) return { ignored: true, reason: 'self-message', sends: 0 };
  const mention = (activity.entities || []).find(e => e.type === 'mention' && e.mentioned?.id === binding.botId);
  if (!mention) return { ignored: true, reason: 'not-mentioned', sends: 0 };
  requireThat(typeof activity.text === 'string' && activity.text.length <= 2500 && typeof mention.text === 'string', 'QUESTION', 'Invalid Teams question.');
  const question = activity.text.replace(mention.text, '').trim();
  const answer = createSteward(snapshot, { ...options, source: 'provided-snapshot' }).ask(question);
  const citations = answer.references.slice(0, 8).map(r => `[${r.kind} #${r.number}](${r.url})`).join(' · ');
  return { ignored: false, activity_id: activity.id, mode: 'test-only', text: `${markdown(answer.text)}${citations ? `\n\n${citations}` : ''}`, refused: !!answer.refused,
    github_mutations: 0, sends: 0, transport: 'reply prepared only; authenticated SDK host must deliver it' };
}
