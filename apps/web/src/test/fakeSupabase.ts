// Test double for the Supabase browser client (auth + realtime only: the app uses nothing else).
import { vi } from "vitest";

type Listener = (event: string, session: FakeSession | null) => void;
interface FakeSession {
  access_token: string;
  user: { id: string };
}
type ChannelCallback = (payload: { new: unknown }) => void;

class FakeSupabase {
  session: FakeSession | null = null;
  listeners = new Set<Listener>();
  channels: { name: string; filter?: string; callback?: ChannelCallback }[] = [];
  removed: string[] = [];
  /** Set to make the next signInWithPassword / signUp fail. */
  signInError: string | null = null;
  signUpError: string | null = null;
  /** signUp result: true = a session is returned immediately (email confirmation off). */
  signUpReturnsSession = false;
  signUpCalls: unknown[] = [];

  reset() {
    this.session = null;
    this.listeners.clear();
    this.channels = [];
    this.removed = [];
    this.signInError = null;
    this.signUpError = null;
    this.signUpReturnsSession = false;
    this.signUpCalls = [];
  }

  private emit(event: string) {
    this.listeners.forEach((l) => l(event, this.session));
  }

  /** Simulate an existing signed-in session before the app mounts. */
  signInAs(userId: string) {
    this.session = { access_token: `token-${userId}`, user: { id: userId } };
  }

  /** Fire a Realtime INSERT to the subscription on the notifications channel. */
  pushRealtime(row: unknown) {
    this.channels.forEach((c) => c.callback?.({ new: row }));
  }

  client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: this.session }, error: null })),
      onAuthStateChange: vi.fn((cb: Listener) => {
        this.listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => this.listeners.delete(cb) } } };
      }),
      signInWithPassword: vi.fn(async ({ email }: { email: string; password: string }) => {
        if (this.signInError) return { data: { session: null }, error: { message: this.signInError } };
        this.signInAs(`user-for-${email}`);
        this.emit("SIGNED_IN");
        return { data: { session: this.session }, error: null };
      }),
      signUp: vi.fn(async (args: unknown) => {
        this.signUpCalls.push(args);
        if (this.signUpError) return { data: { session: null }, error: { message: this.signUpError } };
        if (this.signUpReturnsSession) {
          this.signInAs("new-user");
          this.emit("SIGNED_IN");
        }
        return { data: { session: this.signUpReturnsSession ? this.session : null }, error: null };
      }),
      signOut: vi.fn(async () => {
        this.session = null;
        this.emit("SIGNED_OUT");
        return { error: null };
      }),
    },
    channel: vi.fn((name: string) => {
      const entry: { name: string; filter?: string; callback?: ChannelCallback } = { name };
      this.channels.push(entry);
      const chain = {
        on: (_type: string, opts: { filter?: string }, cb: ChannelCallback) => {
          entry.filter = opts.filter;
          entry.callback = cb;
          return chain;
        },
        subscribe: () => chain,
      };
      return chain;
    }),
    removeChannel: vi.fn(async (c: unknown) => {
      void c;
      this.removed.push("channel");
    }),
  };
}

export const fakeSupabase = new FakeSupabase();
