import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ChatMessage, complete, LlmError } from './llm.js';
import { systemPrompt } from './prompt.js';
import { AssistantTools, TOOL_SPECS } from './tools.js';

const MAX_TOOL_ROUNDS = 5;
const MAX_TURNS = 10;
const MAX_QUESTION_CHARS = 1000;

export interface AskInput {
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface AskResult {
  answer: string;
  tools_used: { name: string; arguments: Record<string, unknown> }[];
  sources: string[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tools: AssistantTools,
  ) {}

  private async context() {
    const [row] = await this.db.query<{ region: string; reports_up_to: string }>(
      `SELECT (SELECT regexp_replace(region, '\\s*\\(fictional\\)\\s*$', '') FROM locations
                GROUP BY region ORDER BY count(*) DESC LIMIT 1) AS region,
              (SELECT to_char(data_until, 'FMMonth YYYY') FROM model_runs WHERE job = 'forecast'
                ORDER BY id DESC LIMIT 1) AS reports_up_to`,
    );
    return { region: row?.region ?? 'the district', reportsUpTo: row?.reports_up_to ?? 'the latest month' };
  }

  async ask(input: AskInput): Promise<AskResult> {
    const history = (input.messages ?? []).filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
    );
    const last = history[history.length - 1];
    if (!last || last.role !== 'user') throw new BadRequestException('The last message must be a question from the user.');
    if (last.content.length > MAX_QUESTION_CHARS) {
      throw new BadRequestException(`Please keep questions under ${MAX_QUESTION_CHARS} characters.`);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(await this.context()) },
      ...history.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content })),
    ];
    const toolsUsed: AskResult['tools_used'] = [];
    const sources = new Set<string>();
    const usage = { prompt_tokens: 0, completion_tokens: 0 };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let result;
      try {
        // On the final round, no tools are offered, so the model must answer with what it has.
        result = await complete(messages, round < MAX_TOOL_ROUNDS ? TOOL_SPECS : []);
      } catch (e) {
        if (e instanceof LlmError) throw new ServiceUnavailableException(e.message);
        throw e;
      }
      usage.prompt_tokens += result.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += result.usage?.completion_tokens ?? 0;
      const msg = result.message;
      const calls = msg.tool_calls ?? [];

      if (!calls.length) {
        return { answer: (msg.content ?? '').trim(), tools_used: toolsUsed, sources: [...sources], usage };
      }

      // Keep the model's reasoning with its tool calls for the rest of this turn.
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls,
                      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          // malformed arguments: the tool reports the problem back to the model
        }
        toolsUsed.push({ name: call.function.name, arguments: args });
        let content: string;
        try {
          const out = await this.tools.run(call.function.name, args);
          sources.add(out.source);
          content = JSON.stringify(out.data);
        } catch (e) {
          content = JSON.stringify({ error: `Tool failed: ${(e as Error).message}` });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    return { answer: 'Sorry, I could not finish answering that. Please try a narrower question.', tools_used: toolsUsed,
             sources: [...sources], usage };
  }
}
