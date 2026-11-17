import { useEffect, useState } from "react";
import { APP_NAME, APP_TAGLINE } from "@kaamsetu/shared";

type ApiState = "checking" | "ok" | "down";

export function App() {
  const [api, setApi] = useState<ApiState>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { ok?: boolean }) => setApi(body.ok ? "ok" : "down"))
      .catch(() => setApi("down"));
  }, []);

  return (
    <main className="page">
      <h1>{APP_NAME}</h1>
      <p>{APP_TAGLINE}</p>
      <p role="status" className={`pill pill-${api}`}>
        {api === "checking" && "Checking server…"}
        {api === "ok" && "Server connected"}
        {api === "down" && "Server not reachable"}
      </p>
      <p className="note">Hello-world build. The product is not implemented yet.</p>
    </main>
  );
}
