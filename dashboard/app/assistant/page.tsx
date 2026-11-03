import Chat from './Chat';

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function AssistantPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? '';
  return (
    <main>
      <div className="page-head">
        <h1>Ask AfyaStock</h1>
        <p>Plain-language answers from the latest reports, forecasts and the Kenya Essential Medicines List.</p>
      </div>
      <Chat initialQuestion={q.slice(0, 1000)} />
    </main>
  );
}
