// The assistant's provider-neutral pieces: the conversation, tools, and what a provider streams
// back. Each provider (anthropic.ts, openai.ts, ollama.ts) translates these to and from its own
// API. Design: docs/assistant.md. No Electron imports, so all of this is tested with plain Node.
import type { AssistantProvider, WorkflowStage } from '../shared/types';

export type ProviderId = AssistantProvider;

/** The tool result given for a call that never ran (the reply was stopped, or the app crashed). */
export const NOT_RUN = 'This tool call was not run (the reply was stopped).';

/** A tool call's arguments from JSON the model streamed, or {} if it isn't valid JSON. */
export function parseToolInput(json: unknown): Record<string, unknown> {
  if (json && typeof json === 'object') return json as Record<string, unknown>;
  if (typeof json !== 'string' || !json) return {};
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? value : {};
  } catch {
    // Leave it empty; the tool will report the missing input.
    return {};
  }
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One turn of the conversation as the model sees it. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

/** A tool the model can call: a JSON Schema for its input, and what it does. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Runs the tool. The result goes back to the model as JSON (or text, if a string). */
  run: (input: Record<string, unknown>, call: ToolCall) => Promise<unknown>;
  /** A few words for the chat while it runs, e.g. "Looking at orders". */
  describe: (input: Record<string, unknown>) => string | Promise<string>;
  /** True if it changes the project: it needs the user's approval and can be undone. */
  change?: boolean;
}

export interface ModelRequest {
  model: string;
  /** Instructions that rarely change (cached where the provider supports it). */
  system: string;
  /** Instructions about the project right now, sent after `system`. */
  context: string;
  turns: Turn[];
  tools: Pick<ToolSpec, 'name' | 'description' | 'parameters'>[];
  maxTokens: number;
}

/** What one model call produced. */
export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  /** 'tools' when the model wants tool results before carrying on. */
  stop: 'end' | 'tools' | 'length' | 'refused';
  usage: { input: number; output: number; cachedInput: number };
}

export interface Provider {
  id: ProviderId;
  /** Calls the model, passing streamed text to onText as it arrives. */
  complete: (
    request: ModelRequest,
    onText: (text: string) => void,
    signal: AbortSignal,
  ) => Promise<ModelResponse>;
  /** The models this key can use, newest first where the API says. */
  listModels: (signal?: AbortSignal) => Promise<string[]>;
}

/** An error from a provider's API, with a message fit to show the user. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type { WorkflowStage };
