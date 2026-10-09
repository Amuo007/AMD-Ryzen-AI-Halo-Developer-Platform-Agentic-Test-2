import { conversationExists, createConversation, setConversationReasoning } from './db.js';

/** Ensure a conversation row exists (create it if the id is unknown). */
export function ensureConversation(id, { title = 'New conversation', mode = 'code', workspace = null, reasoning = null } = {}) {
  if (!conversationExists(id)) createConversation({ id, title, mode, workspace, reasoning: reasoning ?? 'auto' });
  else if (reasoning) setConversationReasoning(id, reasoning);
  return true;
}
