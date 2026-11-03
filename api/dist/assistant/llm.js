export class LlmError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export async function complete(messages, tools) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key)
        throw new LlmError('DEEPSEEK_API_KEY is not set in .env', 500);
    const base = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
    const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, tools, temperature: 0.1, max_tokens: 1200 }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
        const body = await res.text();
        const hint = res.status === 401 ? ' (check DEEPSEEK_API_KEY)' : res.status === 402 ? ' (DeepSeek balance is empty: top up)' : '';
        throw new LlmError(`DeepSeek answered ${res.status}${hint}: ${body.slice(0, 300)}`, res.status);
    }
    const data = (await res.json());
    return { message: data.choices[0].message, usage: data.usage };
}
//# sourceMappingURL=llm.js.map