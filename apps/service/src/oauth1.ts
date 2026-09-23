import { createHmac } from "node:crypto";

export interface OAuth1AuthorizationInput {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  callback?: string;
  verifier?: string;
  nonce: string;
  timestampSeconds: number;
  parameters?: ReadonlyArray<readonly [string, string]>;
  includeVersion?: boolean;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createOAuth1Authorization(input: OAuth1AuthorizationInput): string {
  const url = new URL(input.url);
  const oauth = new Map<string, string>([
    ["oauth_consumer_key", input.consumerKey],
    ["oauth_nonce", input.nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(input.timestampSeconds)],
  ]);
  if (input.includeVersion !== false) oauth.set("oauth_version", "1.0");
  if (input.token !== undefined) oauth.set("oauth_token", input.token);
  if (input.callback !== undefined) oauth.set("oauth_callback", input.callback);
  if (input.verifier !== undefined) oauth.set("oauth_verifier", input.verifier);
  const parameters: Array<readonly [string, string]> = [
    ...url.searchParams.entries(),
    ...(input.parameters ?? []),
    ...oauth.entries(),
  ];
  parameters.sort((left, right) => {
    const leftKey = encode(left[0]);
    const rightKey = encode(right[0]);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    const leftValue = encode(left[1]);
    const rightValue = encode(right[1]);
    return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  });
  const normalized = parameters.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const signatureBase = [input.method.toUpperCase(), encode(baseUrl), encode(normalized)].join("&");
  const signingKey = `${encode(input.consumerSecret)}&${encode(input.tokenSecret ?? "")}`;
  const signature = createHmac("sha1", signingKey).update(signatureBase, "utf8").digest("base64");
  oauth.set("oauth_signature", signature);
  return `OAuth ${[...oauth.entries()]
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([key, value]) => `${encode(key)}="${encode(value)}"`)
    .join(", ")}`;
}
