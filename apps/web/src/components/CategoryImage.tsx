import { useState } from "react";

/** Locally stored photos in public/images (credits in public/images/credits.json). */
export const FILE_BY_SLUG: Record<string, string> = {
  event_help: "cat-event.jpg",
  loading_unloading: "cat-loading.jpg",
  furniture_shifting: "cat-furniture.jpg",
  cleaning: "cat-cleaning.jpg",
  construction_helper: "cat-construction.jpg",
  painting_helper: "cat-painting.jpg",
  gardening: "cat-gardening.jpg",
};

/** Brand-coloured fallback tile (used when a photo is missing), so there is never a broken-image icon. */
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
 * A photo for a work category. The photo is decorative (the category is always named in the text beside it),
 * so it has an empty alt. If the file can't load, a coloured tile with the category initial is shown instead.
 */
export function CategoryImage({ slug, name, className = "" }: { slug: string | undefined; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const file = slug ? FILE_BY_SLUG[slug] : undefined;
  if (!file || failed) {
    return (
      <div aria-hidden="true" className={`flex items-center justify-center text-4xl font-extrabold ${TILE[slug ?? ""] ?? "bg-line text-ink"} ${className}`}>
        {name.trim().charAt(0).toUpperCase() || "K"}
      </div>
    );
  }
  return <img src={`/images/${file}`} alt="" width={320} height={220} loading="lazy" decoding="async" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
}
