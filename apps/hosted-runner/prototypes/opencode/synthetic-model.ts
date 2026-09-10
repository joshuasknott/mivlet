import { Plugin } from '@opencode/plugin';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';

export function syntheticPlugin(setup: () => void, guard: () => void, write: () => string) {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3', provider: 'synthetic', modelId: 'summary', supportedUrls: {},
    async doGenerate() { throw new Error('Streaming only'); },
    async doStream(options) {
      guard();
      const done = options.prompt.some(message => message.role === 'tool');
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (done) parts.push({ type: 'text-start', id: 'result' }, { type: 'text-delta', id: 'result', delta: 'Synthetic task finished.' }, { type: 'text-end', id: 'result' });
      else parts.push({ type: 'tool-call', toolCallId: 'summary-write', toolName: 'write_summary', input: JSON.stringify({ dataset: 'fixture-v1' }) });
      parts.push({ type: 'finish', finishReason: { unified: done ? 'stop' : 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
    },
  };
  return Plugin.define({ id: 'mivlet-synthetic-summary', async setup(ctx) {
    setup();
    await ctx.aisdk.hook('sdk', input => { input.sdk = {}; });
    await ctx.aisdk.hook('language', input => { input.language = model; });
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      editor.add({ name: 'write_summary', description: 'Propose the fixed synthetic fixture summary for approval.', input: { type: 'object', properties: { dataset: { type: 'string', const: 'fixture-v1' } }, required: ['dataset'], additionalProperties: false }, options: { codemode: false }, async execute() { return { content: write() }; } });
    });
  } });
}
