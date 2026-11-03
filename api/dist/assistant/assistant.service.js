var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { complete, LlmError } from './llm.js';
import { systemPrompt } from './prompt.js';
import { AssistantTools, TOOL_SPECS } from './tools.js';
const MAX_TOOL_ROUNDS = 5;
const MAX_TURNS = 10;
const MAX_QUESTION_CHARS = 1000;
let AssistantService = class AssistantService {
    db;
    tools;
    constructor(db, tools) {
        this.db = db;
        this.tools = tools;
    }
    async context() {
        const [row] = await this.db.query(`SELECT (SELECT regexp_replace(region, '\\s*\\(fictional\\)\\s*$', '') FROM locations
                GROUP BY region ORDER BY count(*) DESC LIMIT 1) AS region,
              (SELECT to_char(data_until, 'FMMonth YYYY') FROM model_runs WHERE job = 'forecast'
                ORDER BY id DESC LIMIT 1) AS reports_up_to`);
        return { region: row?.region ?? 'the district', reportsUpTo: row?.reports_up_to ?? 'the latest month' };
    }
    async ask(input) {
        const history = (input.messages ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
        const last = history[history.length - 1];
        if (!last || last.role !== 'user')
            throw new BadRequestException('The last message must be a question from the user.');
        if (last.content.length > MAX_QUESTION_CHARS) {
            throw new BadRequestException(`Please keep questions under ${MAX_QUESTION_CHARS} characters.`);
        }
        const messages = [
            { role: 'system', content: systemPrompt(await this.context()) },
            ...history.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content })),
        ];
        const toolsUsed = [];
        const sources = new Set();
        const usage = { prompt_tokens: 0, completion_tokens: 0 };
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            let result;
            try {
                result = await complete(messages, round < MAX_TOOL_ROUNDS ? TOOL_SPECS : []);
            }
            catch (e) {
                if (e instanceof LlmError)
                    throw new ServiceUnavailableException(e.message);
                throw e;
            }
            usage.prompt_tokens += result.usage?.prompt_tokens ?? 0;
            usage.completion_tokens += result.usage?.completion_tokens ?? 0;
            const msg = result.message;
            const calls = msg.tool_calls ?? [];
            if (!calls.length) {
                return { answer: (msg.content ?? '').trim(), tools_used: toolsUsed, sources: [...sources], usage };
            }
            messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls,
                ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
            for (const call of calls) {
                let args = {};
                try {
                    args = JSON.parse(call.function.arguments || '{}');
                }
                catch {
                }
                toolsUsed.push({ name: call.function.name, arguments: args });
                let content;
                try {
                    const out = await this.tools.run(call.function.name, args);
                    sources.add(out.source);
                    content = JSON.stringify(out.data);
                }
                catch (e) {
                    content = JSON.stringify({ error: `Tool failed: ${e.message}` });
                }
                messages.push({ role: 'tool', tool_call_id: call.id, content });
            }
        }
        return { answer: 'Sorry, I could not finish answering that. Please try a narrower question.', tools_used: toolsUsed,
            sources: [...sources], usage };
    }
};
AssistantService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DatabaseService,
        AssistantTools])
], AssistantService);
export { AssistantService };
//# sourceMappingURL=assistant.service.js.map