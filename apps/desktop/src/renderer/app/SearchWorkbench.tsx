import { useState } from "react";
import { readBridge, type RendererCommandResult } from "./bridge.js";

interface SearchResult {
  id: string;
  type: string;
  title: string;
  content: string;
  matched_fields: string[];
  generation: number;
}

async function search(workspaceId: string, query: string): Promise<RendererCommandResult> {
  const bridge = readBridge();
  if (bridge === null) throw new Error("The desktop bridge is unavailable.");
  const requestId = crypto.randomUUID();
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command: "kiwi.search.local",
    args: { query },
  });
}

export function SearchWorkbench({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [generation, setGeneration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await search(workspaceId, query.trim());
      if (result.error !== undefined) throw new Error(result.error.message);
      setResults(((result.data ?? {})["results"] as SearchResult[] | undefined) ?? []);
      setGeneration(Number((result.data ?? {})["generation"] ?? 0));
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not search this workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="search-workbench" aria-labelledby="local-search-title" aria-busy={busy}>
      <header className="page-head">
        <h2 id="local-search-title">Search this workspace</h2>
        <div className="page-head__spacer" />
        {generation === null ? null : <small>Index generation {generation}</small>}
      </header>
      <form role="search" onSubmit={(event) => void submit(event)}>
        <label htmlFor="workspace-search">Search titles and note text</label>
        <div>
          <input
            id="workspace-search"
            type="search"
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || query.trim() === ""}
          >
            {busy ? "Searching" : "Search"}
          </button>
        </div>
      </form>
      {error !== null ? <p role="alert">{error}</p> : null}
      {searched && results.length === 0 ? (
        <p className="search-workbench__empty">No local results. Try a different word.</p>
      ) : null}
      <ol aria-label="Local search results">
        {results.map((result) => (
          <li key={result.id}>
            <div>
              <strong>{result.title}</strong>
              <small>
                {result.type} · matched {result.matched_fields.join(" and ") || "indexed text"}
              </small>
            </div>
            <p>{result.content.slice(0, 220)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
