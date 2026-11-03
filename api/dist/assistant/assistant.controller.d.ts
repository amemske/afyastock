import { AssistantService, type AskInput } from './assistant.service.js';
export declare class AssistantController {
    private readonly assistant;
    constructor(assistant: AssistantService);
    ask(body: AskInput): Promise<import("./assistant.service.js").AskResult>;
}
