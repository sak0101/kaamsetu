import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Category, Locality } from "./types";

interface ReferenceValue {
  ready: boolean;
  failed: boolean;
  categories: Category[];
  localities: Locality[];
  categoryName(id: number): string;
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
    const cat = new Map(categories.map((c) => [c.id, c.name_en]));
    const loc = new Map(localities.map((l) => [l.id, l.name]));
    return {
      ready: state === "ready",
      failed: state === "failed",
      categories,
      localities,
      categoryName: (id) => cat.get(id) ?? "Work",
      localityName: (id) => loc.get(id) ?? "Vadodara",
    };
  }, [categories, localities, state]);

  return <ReferenceContext.Provider value={value}>{children}</ReferenceContext.Provider>;
}
