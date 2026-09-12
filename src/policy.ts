import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { proto, WAMessage } from '@whiskeysockets/baileys';
import type { Attachment, Command, Config, Identity } from './types.ts';

/** Keep PN and LID namespaces distinct; Baileys' areJidsSameUser does not. */
export function normalizePrivateJid(jid: string | null | undefined): string | undefined {
  if (!jid || !/^\d+(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(jid)) return undefined;
  return jidNormalizedUser(jid);
}

function visibleContent(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let content = message;
  for (let depth = 0; content && depth < 8; depth++) {
    // Do not use Baileys normalizeMessageContent: it unwraps view-once media.
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension
      || content.audioMessage?.viewOnce || content.imageMessage?.viewOnce
      || content.videoMessage?.viewOnce || content.extendedTextMessage?.viewOnce) return undefined;
    const wrapper = content.ephemeralMessage ?? content.documentWithCaptionMessage;
    if (!wrapper) return content;
    content = wrapper.message;
  }
  return undefined;
}

/** Describe attachments without bypassing view-once privacy containers. */
export function getAttachment(message: WAMessage): Attachment | undefined {
  const content = message.key.isViewOnce ? undefined : visibleContent(message.message);
  if (!content) return message.message ? { kind: 'unsupported', message, mimeType: '' } : undefined;
  const audio = content.audioMessage;
  const image = content.imageMessage;
  const document = content.documentMessage;
  if (audio || image || document) {
    const media = audio ?? image ?? document!;
    const mimeType = (media.mimetype ?? '').split(';', 1)[0]!.trim().toLowerCase();
    const kind = audio ? 'audio' : image ? 'image' : mimeType === 'application/pdf' ? 'pdf' : 'unsupported';
    return { kind, mimeType, message: { ...message, message: content } };
  }
  if (content.conversation != null || content.extendedTextMessage) return undefined;
  return { kind: 'unsupported', message, mimeType: '' };
}

function directAudio(message: WAMessage): Attachment | undefined {
  let content = message.message;
  let blocked = !!message.key.isViewOnce;
  for (let depth = 0; content && depth < 8; depth++) {
    const privateWrapper = content.viewOnceMessage ?? content.viewOnceMessageV2 ?? content.viewOnceMessageV2Extension;
    blocked ||= !!privateWrapper || !!content.audioMessage?.viewOnce;
    if (content.audioMessage) {
      if (blocked) return { kind: 'unsupported', message, mimeType: '' };
      return getAttachment({ ...message, message: content });
    }
    // Inspect wrapper/type metadata only to recognize blocked voice. Never read its
    // audio payload or quote context, and never give an unwrapped private message to download.
    const wrapper = content.ephemeralMessage ?? privateWrapper;
    content = wrapper?.message;
  }
  return undefined;
}

export function selectCommands(
  upsert: { type: string; messages: WAMessage[] }, identity: Identity, config: Config,
): Command[] {
  if (upsert.type !== 'notify' || config.pairOnly) return [];
  const accountId = normalizePrivateJid(identity.id);
  if (!accountId) return [];
  const own = new Set([accountId, normalizePrivateJid(identity.lid)].filter((jid): jid is string => !!jid));
  const allowed = new Set([...config.allowedJids].map(normalizePrivateJid).filter((jid): jid is string => !!jid));
  const commands: Command[] = [];
  for (const message of upsert.messages) {
    const remote = normalizePrivateJid(message.key.remoteJid);
    if (!remote || !message.key.id) continue;
    const alternate = normalizePrivateJid(message.key.remoteJidAlt);
    // remoteJidAlt is trusted Baileys addressing metadata, not an embedded quote/mention.
    const pnAlias = remote.endsWith('@lid') && alternate?.endsWith('@s.whatsapp.net') ? alternate : undefined;
    const self = own.has(remote) || !!(pnAlias && own.has(pnAlias));
    if (self ? message.key.fromMe !== true
      : message.key.fromMe !== false || !(allowed.has(remote) || (pnAlias && allowed.has(pnAlias)))) continue;
    const attachment = directAudio(message);
    if (!attachment) continue;
    const command: Command = {
      id: message.key.id,
      accountId,
      chatId: self ? accountId : pnAlias ?? remote,
      replyJid: remote,
      message,
      attachment,
    };
    const context = attachment.kind === 'audio' ? attachment.message.message?.audioMessage?.contextInfo : undefined;
    if (context?.quotedMessage) {
      const participant = normalizePrivateJid(context.participant);
      const quotedChat = context.remoteJid == null ? remote : normalizePrivateJid(context.remoteJid);
      const sameChat = quotedChat === remote || !!(pnAlias && quotedChat === pnAlias) || (self && !!quotedChat && own.has(quotedChat));
      const knownAuthor = participant
        ? own.has(participant) || participant === remote || participant === pnAlias
        : self && context.participant == null;
      const quoted: WAMessage = {
        key: {
          remoteJid: remote,
          remoteJidAlt: message.key.remoteJidAlt,
          id: context.stanzaId,
          fromMe: self || !!(participant && own.has(participant)),
        },
        message: context.quotedMessage,
      };
      const reference = getAttachment(quoted);
      if (reference) {
        command.reference = (reference.kind === 'image' || reference.kind === 'pdf')
          && context.stanzaId && sameChat && knownAuthor
          ? reference : { kind: 'unsupported', message: quoted, mimeType: '' };
      }
    }
    commands.push(command);
  }
  return commands;
}
