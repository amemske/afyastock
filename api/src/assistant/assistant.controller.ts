import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AssistantService, type AskInput } from './assistant.service.js';

@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** Body: { messages: [{ role: 'user' | 'assistant', content: string }] }; the last must be the question. */
  @Post('ask')
  @HttpCode(200)
  ask(@Body() body: AskInput) {
    return this.assistant.ask(body);
  }
}
