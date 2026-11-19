import { useState } from "react";
import { imageFileFor } from "../lib/jobImage";

/** Brand-coloured fallback tile (used when a picture is missing), so there is never a broken-image icon. */
const TILE: Record<string, string> = {
  event_help: "bg-terracotta text-ink",
  loading_unloading: "bg-ink text-white",
  furniture_shifting: "bg-marigold text-ink",
  cleaning: "bg-ink-soft text-white",
  construction_helper: "bg-terracotta-dark text-white",
  painting_helper: "bg-marigold text-ink",
  gardening: "bg-success text-white",
  packing: "bg-terracotta text-ink",
};

/**
 * The picture for a type of work. Pass the job's `title` and `description` for "Event help" jobs and the picture
 * matches the kind of event (wedding, catering, exhibition, religious, corporate). The picture is decorative (the
 * category is always named in the text beside it), so it has an empty alt. If the file can't load, a coloured tile
 * with the category initial is shown instead.
 */
export function CategoryImage({
  slug,
  name,
  className = "",
  title,
  description,
}: {
  slug: string | undefined;
  name: string;
  className?: string;
  title?: string;
  description?: string;
}) {
  const file = imageFileFor(slug, title, description);
  // Remember WHICH file failed, so a card whose job text changes is not stuck on the fallback.
  const [failedFile, setFailedFile] = useState<string | null>(null);
  if (!file || failedFile === file) {
    return (
      <div aria-hidden="true" className={`flex items-center justify-center text-4xl font-extrabold ${TILE[slug ?? ""] ?? "bg-line text-ink"} ${className}`}>
        {name.trim().charAt(0).toUpperCase() || "K"}
      </div>
    );
  }
  return (
    <div className={`overflow-hidden bg-line ${className}`}>
      <img src={`/images/${file}`} alt="" width={320} height={220} loading="lazy" decoding="async" onError={() => setFailedFile(file)} className="h-full w-full object-cover" />
    </div>
  );
}
