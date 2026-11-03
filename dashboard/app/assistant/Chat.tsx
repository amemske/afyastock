'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Database, SendHorizontal } from 'lucide-react';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  error?: boolean;
}

const SUGGESTIONS = [
  'Which facilities need the most attention this week?',
  'Can a dispensary stock ceftriaxone?',
  'What does a KES 100,000 budget cover?',
  'Which transfers are most urgent?',
];

/** Renders plain text with "- " bullet lines as a list. */
function Answer({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const isItem = /^\s*[-•]\s+/.test(line);
    const clean = line.replace(/^\s*[-•]\s+/, '').trim();
    if (!clean) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.list === isItem) last.lines.push(clean);
    else blocks.push({ list: isItem, lines: [clean] });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          b.lines.map((l, j) => <p key={`${i}-${j}`}>{l}</p>)
        ),
      )}
    </>
  );
}

export default function Chat({ initialQuestion = '' }: { initialQuestion?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState(initialQuestion);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [turns, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = [...turns.filter((t) => !t.error), { role: 'user' as const, content: q }];
    setTurns([...turns, { role: 'user', content: q }]);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/assistant/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? `The assistant answered ${res.status}.`);
      setTurns((t) => [...t, { role: 'assistant', content: data.answer, sources: data.sources }]);
    } catch (e) {
      setTurns((t) => [...t, { role: 'assistant', content: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel chat" aria-label="Conversation">
      <div className="chat-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>
              Ask about stock alerts, transfers, orders or the Kenya Essential Medicines List. Every answer comes from
              AfyaStock&apos;s data, with its source.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg msg-${t.role}${t.error ? ' msg-error' : ''}`}>
            {t.role === 'assistant' ? <Answer text={t.content} /> : <p>{t.content}</p>}
            {t.sources && t.sources.length > 0 && (
              <ul className="msg-sources" aria-label="Sources">
                {t.sources.map((s) => (
                  <li key={s}>
                    {s.startsWith('Kenya Essential') ? <BookOpen size={14} aria-hidden /> : <Database size={14} aria-hidden />}
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && <div className="msg msg-assistant msg-busy">Checking AfyaStock&apos;s data…</div>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <label className="visually-hidden" htmlFor="q">
          Your question
        </label>
        <textarea
          id="q"
          rows={2}
          maxLength={1000}
          value={input}
          placeholder="Ask about stock, alerts, transfers, orders or the medicines list"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
          <SendHorizontal size={16} aria-hidden /> Ask
        </button>
      </form>
    </section>
  );
}
