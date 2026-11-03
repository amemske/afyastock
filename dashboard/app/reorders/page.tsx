import Link from 'next/link';
import { api } from '@/lib/api';
import { VEN, kes, qty } from '@/lib/format';

type Search = Promise<Record<string, string | string[] | undefined>>;
const PRESETS = [50000, 150000, 300000, 600000];
const UNFUNDED_SHOWN = 15;

export default async function ReordersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const budgetParam = one(sp.budget).replace(/[^0-9.]/g, '');
  const showAll = one(sp.all) === '1';
  const q = new URLSearchParams();
  if (budgetParam) q.set('budget', budgetParam);
  const plan = await api.reorders(q);
  const s = plan.summary;

  if (!s) {
    return (
      <main>
        <div className="page-head">
          <h1>Reorders</h1>
        </div>
        <div className="panel empty">No reorder plan yet. Run the optimiser to create one.</div>
      </main>
    );
  }

  const funded = plan.lines.filter((l) => l.within_budget);
  const unfunded = plan.lines.filter((l) => !l.within_budget);
  const shownUnfunded = showAll ? unfunded : unfunded.slice(0, UNFUNDED_SHOWN);
  const share = s.expected_stockouts_total ? s.expected_stockouts_prevented / s.expected_stockouts_total : 0;
  const budgetHref = (b: number) => `/reorders?budget=${b}`;

  return (
    <main>
      <div className="page-head">
        <h1>Reorders</h1>
        <p>
          Orders for every medicine still at risk after transfers, ranked by how much stockout risk each shilling
          prevents. Vital medicines count three times as much as non-essential ones.
        </p>
      </div>

      <section className="panel" style={{ marginBottom: '1.25rem' }} aria-labelledby="budget-h">
        <div className="panel-head">
          <h2 id="budget-h">Budget for this order round</h2>
        </div>
        <div className="panel-body">
          <form className="budget-form" method="get" action="/reorders">
            <label className="field">
              <span>Amount in KES</span>
              <input name="budget" inputMode="numeric" defaultValue={String(s.budget_kes)} />
            </label>
            <button className="btn btn-primary" type="submit">
              Update plan
            </button>
            <div className="presets">
              {PRESETS.map((b) => (
                <Link key={b} href={budgetHref(b)} aria-current={b === s.budget_kes ? 'true' : undefined}>
                  {kes(b)}
                </Link>
              ))}
            </div>
          </form>
        </div>
      </section>

      <dl className="stats">
        <div className="panel stat">
          <dt>Orders this budget covers</dt>
          <dd className="num">
            {s.lines_funded} of {s.lines_total}
            <small>costing {kes(s.cost_funded_kes)}</small>
          </dd>
        </div>
        <div className="panel stat">
          <dt>Vital medicine orders covered</dt>
          <dd className="num">
            {s.vital_funded} of {s.vital_total}
          </dd>
        </div>
        <div className="panel stat">
          <dt>Expected stockouts prevented</dt>
          <dd className="num">
            {s.expected_stockouts_prevented} of {s.expected_stockouts_total}
            <span className="progress" aria-hidden>
              <i style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
          </dd>
        </div>
        <div className="panel stat">
          <dt>Cost to order everything</dt>
          <dd className="num">
            {kes(s.cost_total_kes)}
            <small>{kes(Math.max(0, s.cost_total_kes - s.cost_funded_kes))} more than this budget</small>
          </dd>
        </div>
      </dl>

      <section className="panel otable" aria-label="Orders in priority order">
        <div className="thead" aria-hidden="true">
          <span>#</span>
          <span>Medicine</span>
          <span>Facility</span>
          <span>Priority</span>
          <span className="right">Quantity</span>
          <span className="right">Cost</span>
          <span className="right">Running total</span>
        </div>
        <ol className="rows">
          {funded.map((l) => (
            <Row key={l.id} l={l} />
          ))}
          {unfunded.length > 0 && (
            <li className="budget-line">
              Budget reached. The orders below are not covered by {kes(s.budget_kes)}.
            </li>
          )}
          {shownUnfunded.map((l) => (
            <Row key={l.id} l={l} />
          ))}
        </ol>
        {!showAll && unfunded.length > UNFUNDED_SHOWN && (
          <div className="more">
            <Link href={`/reorders?budget=${s.budget_kes}&all=1`}>
              Show all {unfunded.length} orders outside the budget
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

function Row({ l }: { l: Awaited<ReturnType<typeof api.reorders>>['lines'][number] }) {
  const content = (
    <>
      <span className="num">{l.rank}</span>
      <span>{l.item_name}</span>
      <span>{l.location_name}</span>
      <span>
        <span className={`ven ven-${l.ven}`}>{VEN[l.ven] ?? l.ven}</span>
      </span>
      <span className="right num">
        {qty(l.quantity, l.unit)}
      </span>
      <span className="right num">{kes(l.cost)}</span>
      <span className="right num">{kes(l.cumulative_cost)}</span>
    </>
  );
  return (
    <li>
      {l.alert_id ? (
        <Link href={`/alerts/${l.alert_id}`} className={`orow${l.within_budget ? '' : ' unfunded'}`}>
          {content}
        </Link>
      ) : (
        <div className={`orow${l.within_budget ? '' : ' unfunded'}`}>{content}</div>
      )}
    </li>
  );
}
