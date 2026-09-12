import type { WAMessage } from '@whiskeysockets/baileys';

export interface Config {
  apiKey: string;
  model: string;
  transcriptionModel: string;
  databasePath: string;
  allowedJids: Set<string>;
  pairOnly: boolean;
  dashboardOnly: boolean;
  dashboardPort: number;
  timeZone: string;
}
export interface Identity { id: string; lid?: string }
export interface Attachment {
  kind: 'audio' | 'image' | 'pdf' | 'unsupported';
  message: WAMessage;
  mimeType: string;
  filename?: string;
}
export interface Command {
  id: string;
  accountId: string;
  chatId: string;
  replyJid: string;
  message: WAMessage;
  attachment: Attachment;
  reference?: Attachment;
}
export interface Media { bytes: Buffer; mimeType: string; filename: string; kind: 'audio' | 'image' | 'pdf' }
export interface PreparedInput { audio: Media; reference?: Media }
export interface HistoryItem { role: 'user' | 'assistant'; content: string }
export interface OutboundDocument { bytes: Buffer; mimeType: 'application/pdf'; filename: string }
export interface AgentReply { userText: string; replyText: string; document?: OutboundDocument }
export class UserInputError extends Error {
  constructor(message: string) { super(message); this.name = 'UserInputError'; }
}
// Only sanitized provider diagnostics belong in this user-visible error.
export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'ProviderError'; }
}
