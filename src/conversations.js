import { conversationExists, createConversation } from './db.js';

/** Ensure a conversation row exists (create it if the id is unknown). */
export function ensureConversation(id, { title = 'New conversation', mode = 'code', workspace = null } = {}) {
  if (!conversationExists(id)) createConversation({ id, title, mode, workspace });
  return true;
}
