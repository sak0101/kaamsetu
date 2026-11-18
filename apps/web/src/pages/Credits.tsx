import { useEffect } from "react";
import { fetchPhotoCredits } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingBlock } from "../components/ui";

/** Attribution for every photograph shown in the app (required by the CC BY / CC BY-SA licences). */
export function Credits() {
  const credits = useAsync(() => fetchPhotoCredits(), []);

  useEffect(() => {
    document.title = "Photo credits · KaamSetu";
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl">Photo credits</h1>
      <p className="mt-2 text-ink-soft">
        The photographs on KaamSetu come from Wikimedia Commons and are used under the licences below. They show real scenes from across India, not
        KaamSetu workers or customers. Thank you to the photographers.
      </p>
      <div className="mt-6">
        {credits.loading && !credits.data ? (
          <LoadingBlock label="Loading credits…" rows={2} />
        ) : credits.error ? (
          <ErrorState error={credits.error} onRetry={credits.reload} />
        ) : (
          <ul className="flex flex-col gap-4">
            {credits.data!.map((c) => (
              <li key={c.file} className="rounded-xl border border-line bg-paper p-4">
                <p className="font-bold">{c.title}</p>
                <p className="text-ink-soft">
                  By {c.author}. Licence:{" "}
                  <a href={c.license_url} className="font-semibold text-ink underline" target="_blank" rel="noreferrer noopener">
                    {c.license}
                  </a>
                  .{" "}
                  <a href={c.source_url} className="font-semibold text-ink underline" target="_blank" rel="noreferrer noopener">
                    Original on Wikimedia Commons
                  </a>
                </p>
                {c.notes && <p className="mt-1 text-sm text-ink-soft">{c.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
