import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { api } from "./api";

/**
 * Browser Supabase client. Used ONLY for authentication (sign-up / sign-in /
 * session refresh) and Realtime subscriptions. Every read and write of
 * application data goes through the Express API.
 *
 * The URL and anon key are fetched once at runtime from GET /api/public-config
 * (they are public by design), so nothing is baked into the build. The
 * service-role key is never available to the browser.
 */
let clientPromise: Promise<SupabaseClient> | null = null;

export function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = api
      .publicConfig()
      .then((cfg) =>
        createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        }),
      )
      .catch((err) => {
        clientPromise = null; // allow a retry
        throw err;
      });
  }
  return clientPromise;
}
