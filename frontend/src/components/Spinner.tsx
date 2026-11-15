export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <span className="spinner" aria-hidden />
      {label && <span className="visually-hidden">{label}</span>}
    </>
  );
}

export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-screen" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}
