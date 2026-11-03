import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, CircleAlert, Info, MapPin, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { STATUS, cover, monthYear, num, pct, placeType } from '@/lib/format';
import StockChart from './StockChart';

const RULES: Record<string, string> = {
  missing_report: 'Report missing',
  all_zero_report: 'Blank report',
  balance_mismatch: 'Figures did not add up',
  negative_value: 'Impossible figure',
  incomplete_report: 'Incomplete report',
  duplicate_report: 'Sent twice',
};

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) notFound();

  let data;
  try {
    data = await api.alert(n);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const { alert: a, history, forecast, issues } = data;

  // Facts the system knows for certain come first; model reasons (SHAP) follow and are marked as such.
  const facts = a.drivers.filter((d) => d.effect === undefined);
  const modelReasons = a.drivers.filter((d) => d.effect !== undefined);
  const last = history[history.length - 1];
  const next = forecast[0];
  const recentUse = history.slice(-6).filter((h) => !h.imputed);
  const emptyMonths = history.slice(-6).filter((h) => h.empty_shelf).length;
  const typeLabel = placeType(a.location_type);
  const showType = !a.location_name.toLowerCase().includes(typeLabel.toLowerCase());

  return (
    <main className={`s-${a.status}`}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">
          <ChevronLeft size={16} aria-hidden /> Stock alerts
        </Link>
      </nav>

      <header className="panel detail-head">
        <span className="badge">{STATUS[a.status].label}</span>
        <h1>{a.item_name}</h1>
        <p className="where">
          <MapPin size={16} aria-hidden />
          {a.location_name}
          {showType && `, ${typeLabel.toLowerCase()}`}, {a.rural ? 'rural' : 'urban'}
        </p>
      </header>

      <dl className="tiles">
        <div className="panel tile">
          <dt>{a.status === 'expiry' ? 'Share of expiring stock at risk' : 'Chance of running out'}</dt>
          <dd className="num">{a.status === 'out_now' ? 'Already out' : pct(a.risk)}</dd>
        </div>
        <div className="panel tile">
          <dt>On the shelf, end of {last ? monthYear(last.period) : 'last month'}</dt>
          <dd className="num">
            {last ? num(last.closing) : '–'} <small>{a.unit}s</small>
          </dd>
        </div>
        <div className="panel tile">
          <dt>Forecast use, {next ? monthYear(next.period) : 'next month'}</dt>
          <dd className="num">
            {next ? num(next.predicted) : '–'} <small>{a.unit}s</small>
          </dd>
        </div>
        <div className="panel tile">
          <dt>Stock lasts</dt>
          <dd>{cover(a.months_of_stock).replace(' of stock', '')}</dd>
        </div>
      </dl>

      <section className="panel" aria-labelledby="history">
        <div className="panel-head">
          <h2 id="history">Stock and use, last two years</h2>
          <p>
            Empty-shelf months in the last 6: <strong className="num">{emptyMonths}</strong>
          </p>
        </div>
        <div className="panel-body">
          <StockChart history={history} forecast={forecast} unit={a.unit} />
          {next && (
            <p className="forecast-line">
              Forecast for {monthYear(next.period)}: about {num(next.predicted)} {a.unit}s, likely between{' '}
              {num(next.lower)} and {num(next.upper)}.
              {recentUse.length > 0 && (
                <>
                  {' '}
                  Recorded use over the last {recentUse.length} reported months averaged{' '}
                  {num(recentUse.reduce((s, h) => s + h.used, 0) / recentUse.length)}
                  {emptyMonths > 0 ? ', held down by the months the shelf was empty.' : '.'}
                </>
              )}
            </p>
          )}
        </div>
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="why">
          <div className="panel-head">
            <h2 id="why">Why this is flagged</h2>
          </div>
          <div className="panel-body">
            <ul className="reasons">
              {facts.map((d) => (
                <li key={d.text} className="fact">
                  <CircleAlert size={16} aria-hidden />
                  <span>{d.text}</span>
                </li>
              ))}
              {modelReasons.map((d) => (
                <li key={d.text} className="model">
                  <Sparkles size={16} aria-hidden />
                  <span>Model: {d.text.charAt(0).toLowerCase() + d.text.slice(1)}</span>
                </li>
              ))}
            </ul>
            {a.confidence === 'low' && (
              <p className="reasons-note">
                Lower confidence: recent reports from this facility were missing or the shelf was often empty, so the
                forecast has less to go on.
              </p>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="data">
          <div className="panel-head">
            <h2 id="data">Data notes</h2>
            <p>{issues.length ? `${issues.length} report${issues.length === 1 ? '' : 's'} fixed or estimated` : 'All reports complete'}</p>
          </div>
          <div className="panel-body">
            {issues.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                <Info size={16} aria-hidden style={{ verticalAlign: '-0.15rem', marginRight: '0.4rem' }} />
                Every monthly report for this medicine at this facility was complete and added up.
              </p>
            ) : (
              <ul className="issues">
                {issues.map((i) => (
                  <li key={`${i.period}-${i.rule}`}>
                    <span className="when">{monthYear(i.period)}</span>
                    <span className="what">
                      <strong>{RULES[i.rule] ?? i.rule}.</strong> {i.action_taken}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
