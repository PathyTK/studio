import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';

export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } };
export type TextBlock = { type: 'text'; text: string };
export interface AiMessage { role: 'user' | 'assistant'; content: string | (ImageBlock | TextBlock)[] }
export interface AiClient {
  mock: boolean;
  provider: 'anthropic' | 'openai-compatible' | 'mock';
  model: string;
  stream(req: { system: string; messages: AiMessage[] }): AsyncIterable<string>;
}

export const SYSTEM_PROMPT = `You are Pathy AI, an assistant inside a whole-slide-image viewer used for pathology education and research.
You receive a screenshot of what the user currently sees (and sometimes a close-up of an annotation they drew), plus context such as the slide name, magnification and the user's note.
- Describe what is visible: tissue architecture, cell morphology, staining, artefacts. Say which features support each conclusion.
- When asked to identify the organ or tissue, give your best candidates ranked, with the reasoning, and state your confidence. Say when the view is too zoomed in or too small to tell.
- When asked about an annotation, comment on the outlined region specifically.
- You are NOT a diagnostic device. Never give a definitive diagnosis or clinical advice; remind the user that findings must be confirmed by a qualified pathologist when the question touches diagnosis.
- Be concise (a few short paragraphs or bullets). If the image is missing or unusable, say so and ask for a different view.`;

export function makeAiClient(cfg: Config): AiClient | null {
  if (cfg.anthropicApiKey) {
    const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    return {
      mock: false,
      provider: 'anthropic',
      model: cfg.anthropicModel,
      async *stream({ system, messages }) {
        const s = client.messages.stream({ model: cfg.anthropicModel, max_tokens: 1024, system, messages });
        for await (const ev of s) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
        }
      },
    };
  }
  if (cfg.llmBaseUrl && cfg.llmModel) return makeOpenAiCompatClient(cfg.llmBaseUrl, cfg.llmModel, cfg.llmApiKey);
  if (!cfg.production) {
    return {
      mock: true,
      provider: 'mock',
      model: 'mock',
      async *stream({ messages }) {
        const last = messages[messages.length - 1];
        const hasImage = Array.isArray(last.content) && last.content.some(b => b.type === 'image');
        const text = `[Mock AI: set ANTHROPIC_API_KEY in .env to get real answers] I received your message${hasImage ? ' together with an image of your current view' : ''}. With a real key I would describe the tissue, rank candidate organs and comment on your annotation.`;
        for (const w of text.split(' ')) { yield w + ' '; await new Promise(r => setTimeout(r, 15)); }
      },
    };
  }
  return null;
}

type OaContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

export function toOpenAiMessages(system: string, messages: AiMessage[]) {
  return [
    { role: 'system', content: system },
    ...messages.map(m => ({
      role: m.role,
      content: (typeof m.content === 'string' ? m.content : m.content.map(b =>
        b.type === 'text' ? { type: 'text' as const, text: b.text }
          : { type: 'image_url' as const, image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })) as OaContent,
    })),
  ];
}

/** Streams from any OpenAI-compatible /chat/completions endpoint (Ollama exposes one at http://host:11434/v1). */
export function makeOpenAiCompatClient(baseUrl: string, model: string, apiKey?: string): AiClient {
  return {
    mock: false,
    provider: 'openai-compatible',
    model,
    async *stream({ system, messages }) {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, stream: true, max_tokens: 800, messages: toOpenAiMessages(system, messages) }),
      });
      if (!r.ok || !r.body) throw new Error(`LLM backend answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try { const t = JSON.parse(data).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* keep-alive or partial line */ }
        }
      }
    },
  };
}
