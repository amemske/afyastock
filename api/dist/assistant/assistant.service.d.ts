import { DatabaseService } from '../database/database.service.js';
import { AssistantTools } from './tools.js';
export interface AskInput {
    messages: {
        role: 'user' | 'assistant';
        content: string;
    }[];
}
export interface AskResult {
    answer: string;
    tools_used: {
        name: string;
        arguments: Record<string, unknown>;
    }[];
    sources: string[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}
export declare class AssistantService {
    private readonly db;
    private readonly tools;
    constructor(db: DatabaseService, tools: AssistantTools);
    private context;
    ask(input: AskInput): Promise<AskResult>;
}
