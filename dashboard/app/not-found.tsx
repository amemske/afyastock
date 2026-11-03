import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="panel error-box">
      <h2>This alert no longer exists</h2>
      <p>Alerts are replaced each time the forecast runs. Go back to the current list to see the latest.</p>
      <Link href="/">Go to current alerts</Link>
    </section>
  );
}
