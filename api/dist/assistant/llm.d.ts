export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}
export interface ToolSpec {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface CompletionResult {
    message: ChatMessage;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}
export declare class LlmError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare function complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<CompletionResult>;
