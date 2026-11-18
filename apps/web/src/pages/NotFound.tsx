import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4 text-center">
      <h1 className="text-3xl">Page not found</h1>
      <p className="text-ink-soft">The page you're looking for doesn't exist or has moved.</p>
      <p>
        <Link to="/" className="font-semibold text-ink underline">Back to KaamSetu</Link>
      </p>
    </div>
  );
}
