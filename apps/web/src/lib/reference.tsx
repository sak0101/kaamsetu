import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import type { Category, Locality } from "./types";

interface ReferenceValue {
  ready: boolean;
  failed: boolean;
  categories: Category[];
  localities: Locality[];
  categoryName(id: number): string;
  /** The category name in the signed-in user's language (English, Hindi or Gujarati), falling back to English. */
  categoryLabel(c: Category): string;
  localityName(id: number): string;
}

const ReferenceContext = createContext<ReferenceValue | null>(null);

export function useReference(): ReferenceValue {
  const ctx = useContext(ReferenceContext);
  if (!ctx) throw new Error("useReference must be used inside <ReferenceProvider>");
  return ctx;
}

/** Loads work categories and localities once per signed-in session. */
export function ReferenceProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [localities, setLocalities] = useState<Locality[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const { me } = useAuth();
  const language = me?.profile.preferred_language ?? "en";

  useEffect(() => {
    let alive = true;
    Promise.all([api.categories(), api.localities()]).then(
      ([c, l]) => {
        if (!alive) return;
        setCategories(c.categories);
        setLocalities(l.localities);
        setState("ready");
      },
      () => alive && setState("failed"),
    );
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<ReferenceValue>(() => {
    const label = (c: Category) => (language === "hi" && c.name_hi) || (language === "gu" && c.name_gu) || c.name_en;
    const cat = new Map(categories.map((c) => [c.id, label(c)]));
    const loc = new Map(localities.map((l) => [l.id, l.name]));
    return {
      ready: state === "ready",
      failed: state === "failed",
      categories,
      localities,
      categoryName: (id) => cat.get(id) ?? "Work",
      categoryLabel: label,
      localityName: (id) => loc.get(id) ?? "Vadodara",
    };
  }, [categories, localities, state, language]);

  return <ReferenceContext.Provider value={value}>{children}</ReferenceContext.Provider>;
}
