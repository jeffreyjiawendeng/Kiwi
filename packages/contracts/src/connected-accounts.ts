export const CONNECTED_ACCOUNT_PATHS = {
  list: "/v1/account/connections",
  start: "/v1/account/connections/start",
  poll: "/v1/account/connections/poll",
  disconnect: "/v1/account/connections/disconnect",
  callback: "/v1/connections/callback",
} as const;

export type ConnectedProviderId = "github" | "zotero" | "mendeley" | "osf" | "figshare" | "zenodo";

export type ConnectionProtocol = "oauth2" | "device" | "oauth1";

export interface ConnectedProviderDescriptor {
  id: ConnectedProviderId;
  label: string;
  purpose: string;
  protocol: ConnectionProtocol;
  /** The feature a connection to this provider exists for. */
  consumed_by: string;
}

// A closed registry. A provider that is not listed here cannot be connected, which keeps
// consent and scope surface bounded.
export const CONNECTED_PROVIDERS: readonly ConnectedProviderDescriptor[] = [
  {
    id: "github",
    label: "GitHub",
    purpose: "Repository synchronization and Git integration",
    protocol: "device",
    consumed_by: "repository synchronization",
  },
  {
    id: "zotero",
    label: "Zotero",
    purpose: "Reference library import and citation",
    protocol: "oauth1",
    consumed_by: "reference import",
  },
  {
    id: "mendeley",
    label: "Mendeley",
    purpose: "Reference library import",
    protocol: "oauth2",
    consumed_by: "reference import",
  },
  {
    id: "osf",
    label: "Open Science Framework",
    purpose: "Project and file exchange",
    protocol: "oauth2",
    consumed_by: "project exchange",
  },
  {
    id: "figshare",
    label: "figshare",
    purpose: "Dataset and artifact publication",
    protocol: "oauth2",
    consumed_by: "dataset publication",
  },
  {
    id: "zenodo",
    label: "Zenodo",
    purpose: "Dataset publication and DOI minting",
    protocol: "oauth2",
    consumed_by: "dataset publication",
  },
];

export function isConnectedProviderId(value: unknown): value is ConnectedProviderId {
  return CONNECTED_PROVIDERS.some((provider) => provider.id === value);
}

export interface ConnectedAccountSummary {
  provider: ConnectedProviderId;
  account_label: string;
  scopes: string;
  connected_at: string;
  authorization_status: "active" | "reauthorization_required";
}

export interface ConnectedAccountsSnapshot {
  connections: ConnectedAccountSummary[];
  available: ConnectedProviderId[];
}

export interface DeviceAuthorizationPrompt {
  verification_uri: string;
  user_code: string;
  expires_in_seconds: number;
}

export type ConnectedAccountsResult =
  | { status: "ok"; connections: ConnectedAccountsSnapshot }
  | { status: "browser_required"; authorization_url: string; transaction_id: string }
  | { status: "device_required"; transaction_id: string; prompt: DeviceAuthorizationPrompt }
  | { status: "pending" }
  | { status: "connected"; provider: ConnectedProviderId }
  | {
      status: "disconnected";
      provider: ConnectedProviderId;
      provider_revocation: "confirmed" | "not_supported" | "failed";
    }
  | {
      status: "error";
      code:
        | "invalid_input"
        | "forbidden"
        | "recent_auth_required"
        | "provider_unavailable"
        | "provider_denied"
        | "not_configured"
        | "service_unavailable";
      message: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

export function readConnectionStart(value: unknown): { provider: ConnectedProviderId } | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "provider") &&
    isConnectedProviderId(input["provider"])
    ? { provider: input["provider"] }
    : null;
}

export function readConnectionPoll(value: unknown): { transaction_id: string } | null {
  const input = record(value);
  return input !== null &&
    Object.keys(input).every((key) => key === "transaction_id") &&
    boundedText(input["transaction_id"], 100)
    ? { transaction_id: input["transaction_id"] }
    : null;
}

export function readConnectionDisconnect(value: unknown): { provider: ConnectedProviderId } | null {
  return readConnectionStart(value);
}

export function isConnectedAccountsResult(value: unknown): value is ConnectedAccountsResult {
  const result = record(value);
  if (result === null || typeof result["status"] !== "string") return false;
  const status = result["status"];
  if (status === "pending") return Object.keys(result).length === 1;
  if (status === "connected") {
    return (
      Object.keys(result).every((key) => key === "status" || key === "provider") &&
      isConnectedProviderId(result["provider"])
    );
  }
  if (status === "disconnected") {
    return (
      Object.keys(result).every((key) =>
        ["status", "provider", "provider_revocation"].includes(key),
      ) &&
      isConnectedProviderId(result["provider"]) &&
      ["confirmed", "not_supported", "failed"].includes(String(result["provider_revocation"]))
    );
  }
  if (status === "browser_required") {
    return (
      Object.keys(result).every((key) =>
        ["status", "authorization_url", "transaction_id"].includes(key),
      ) &&
      boundedText(result["authorization_url"], 2_000) &&
      boundedText(result["transaction_id"], 100)
    );
  }
  if (status === "device_required") {
    const prompt = record(result["prompt"]);
    return (
      Object.keys(result).every((key) => ["status", "transaction_id", "prompt"].includes(key)) &&
      boundedText(result["transaction_id"], 100) &&
      prompt !== null &&
      Object.keys(prompt).every((key) =>
        ["verification_uri", "user_code", "expires_in_seconds"].includes(key),
      ) &&
      boundedText(prompt["verification_uri"], 500) &&
      boundedText(prompt["user_code"], 40) &&
      typeof prompt["expires_in_seconds"] === "number"
    );
  }
  if (status === "error") {
    return (
      Object.keys(result).every((key) => ["status", "code", "message"].includes(key)) &&
      [
        "invalid_input",
        "forbidden",
        "recent_auth_required",
        "provider_unavailable",
        "provider_denied",
        "not_configured",
        "service_unavailable",
      ].includes(String(result["code"])) &&
      boundedText(result["message"], 500)
    );
  }
  if (status !== "ok") return false;
  const snapshot = record(result["connections"]);
  const connections = snapshot?.["connections"];
  const available = snapshot?.["available"];
  return (
    Object.keys(result).every((key) => key === "status" || key === "connections") &&
    snapshot !== null &&
    Object.keys(snapshot).every((key) => key === "connections" || key === "available") &&
    Array.isArray(connections) &&
    connections.length <= 20 &&
    connections.every((entry) => {
      const item = record(entry);
      return (
        item !== null &&
        Object.keys(item).every((key) =>
          ["provider", "account_label", "scopes", "connected_at", "authorization_status"].includes(
            key,
          ),
        ) &&
        isConnectedProviderId(item["provider"]) &&
        boundedText(item["account_label"], 255) &&
        typeof item["scopes"] === "string" &&
        (item["authorization_status"] === "active" ||
          item["authorization_status"] === "reauthorization_required") &&
        item["scopes"].length <= 500 &&
        boundedText(item["connected_at"], 50)
      );
    }) &&
    Array.isArray(available) &&
    available.every((provider) => isConnectedProviderId(provider))
  );
}
