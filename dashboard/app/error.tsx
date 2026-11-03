'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <section className="panel error-box" role="alert">
      <h2>The alerts could not be loaded</h2>
      <p>{error.message || 'Something went wrong while loading this page.'}</p>
      <p>
        Check that the API is running: in the <code>api</code> folder, run <code>npm run start:dev</code>.
        Then try again.
      </p>
      <button className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
