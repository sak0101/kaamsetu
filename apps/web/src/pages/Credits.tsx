import { useEffect } from "react";
import { fetchPhotoCredits } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorState, LoadingBlock } from "../components/ui";

/**
 * Where the pictures come from. KaamSetu's own pictures are original illustrations made for it. Any third-party photograph
 * that is ever added must be listed in public/images/credits.json (the licences require attribution) and appears here.
 */
export function Credits() {
  const credits = useAsync(() => fetchPhotoCredits(), []);

  useEffect(() => {
    document.title = "Image credits · KaamSetu";
  }, []);

  const list = credits.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl">Image credits</h1>
      <p className="mt-2 text-ink-soft">
        The pictures on KaamSetu (the work types, the kinds of event, and the home page scene) are original illustrations made for KaamSetu. They don't show
        real places or real people.
      </p>
      <div className="mt-6">
        {credits.loading && !credits.data ? (
          <LoadingBlock label="Loading credits…" rows={2} />
        ) : credits.error ? (
          <ErrorState error={credits.error} onRetry={credits.reload} />
        ) : list.length === 0 ? (
          <p className="rounded-xl border border-line bg-paper p-4">No third-party photographs are used.</p>
        ) : (
          <>
            <h2 className="text-xl">Photographs</h2>
            <p className="mt-1 text-ink-soft">These photographs come from Wikimedia Commons and are used under the licences below. They show real scenes, not KaamSetu workers or customers.</p>
            <ul className="mt-4 flex flex-col gap-4">
              {list.map((c) => (
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
          </>
        )}
      </div>
    </div>
  );
}
