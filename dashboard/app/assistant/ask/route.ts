import { API_URL } from '@/lib/api';

/** Forwards chat requests to the AfyaStock API, so the browser never talks to it directly. */
export async function POST(req: Request) {
  const body = await req.text();
  try {
    const res = await fetch(`${API_URL}/assistant/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return Response.json({ message: `Can't reach the AfyaStock API at ${API_URL}.` }, { status: 502 });
  }
}
