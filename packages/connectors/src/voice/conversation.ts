import type { ConversationVoice, VoiceConversationRequest, VoiceConversationScope, VoiceConversationSession } from "@fable/protocol";

export interface VoiceConversationPort {
  start(scope: VoiceConversationScope): Promise<VoiceConversationSession>;
  heartbeat(session: VoiceConversationSession): Promise<void>;
  interrupt(session: VoiceConversationSession, generation: number): Promise<void>;
  end(session: VoiceConversationSession): Promise<void>;
  transcribe(request: VoiceConversationRequest & { audioBase64: string }): Promise<{ transcript: string }>;
  speak(request: VoiceConversationRequest & { text: string; voice: ConversationVoice }): Promise<{ audioBase64: string }>;
}

/** Keep formatting and code out of speech; the complete response remains in chat. */
export function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " Code is available in the conversation. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link in the conversation")
    .replace(/<[^>]*>/g, "")
    .replace(/^[\s]*[>#*-]+\s*/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ").trim();
}

/** Buffer complete sentences; never read an unfinished Markdown link/code block. */
export function takeSpeechChunk(buffer: string, final = false): { text: string; rest: string } | null {
  const fence = buffer.indexOf("```");
  if (fence >= 0 && buffer.indexOf("```", fence + 3) < 0 && !final) return null;
  const sentence = /[.!?](?:["'”’])?(?:\s|$)|\n\n/.exec(buffer);
  let end = sentence ? sentence.index + sentence[0].length : 0;
  if (end > 600 && fence < 0) end = Math.max(1, buffer.lastIndexOf(" ", 600));
  if (!end && (final || buffer.length > 600)) end = buffer.length > 600 ? buffer.lastIndexOf(" ", 600) : buffer.length;
  if (end <= 0) return null;
  // An incomplete link is left until its destination arrives.
  if (!final && (buffer.slice(0, end).match(/\[/g)?.length ?? 0) > (buffer.slice(0, end).match(/\]/g)?.length ?? 0)) return null;
  if (fence >= 0 && fence < end) {
    const close = buffer.indexOf("```", fence + 3);
    if (close >= end) end = close + 3;
  }
  return { text: speechText(buffer.slice(0, end)), rest: buffer.slice(end) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
