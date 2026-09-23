import type { ConnectedProviderId } from "@kiwi/contracts";

export interface OAuth2ConnectionEndpoints {
  protocol: "oauth2";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  identityEndpoint: string;
  identityIdField: string;
  identityLabelField: string;
  scope: string;
  usesPkce: boolean;
  tokenAuthentication?: "client_secret_post" | "client_secret_basic";
  refreshIncludesRedirectUri?: boolean;
  identityAccept?: string;
  identityAuthorizationScheme?: "Bearer" | "token";
}

export interface DeviceConnectionEndpoints {
  protocol: "device";
  deviceEndpoint: string;
  tokenEndpoint: string;
  identityEndpoint: string;
  identityIdField: string;
  identityLabelField: string;
  scope: string;
}

export interface OAuth1ConnectionEndpoints {
  protocol: "oauth1";
  requestTokenEndpoint: string;
  authorizationEndpoint: string;
  accessTokenEndpoint: string;
  revocationEndpoint: string;
  scope: string;
  authorizationParameters: Readonly<Record<string, string>>;
}

export type TokenConnectionEndpoints = OAuth2ConnectionEndpoints | DeviceConnectionEndpoints;
export type ConnectionEndpoints = TokenConnectionEndpoints | OAuth1ConnectionEndpoints;

// Scopes are the least each provider needs to identify the connected account. A feature that
// consumes a connection widens its own scope through a separate decision.
export const CONNECTION_ENDPOINTS: Partial<Record<ConnectedProviderId, ConnectionEndpoints>> = {
  github: {
    protocol: "device",
    deviceEndpoint: "https://github.com/login/device/code",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    identityEndpoint: "https://api.github.com/user",
    identityIdField: "id",
    identityLabelField: "login",
    scope: "read:user",
  },
  zotero: {
    protocol: "oauth1",
    requestTokenEndpoint: "https://www.zotero.org/oauth/request",
    authorizationEndpoint: "https://www.zotero.org/oauth/authorize",
    accessTokenEndpoint: "https://www.zotero.org/oauth/access",
    revocationEndpoint: "https://api.zotero.org/keys",
    scope: "library:read notes:read groups:read",
    authorizationParameters: {
      name: "Kiwi",
      library_access: "1",
      notes_access: "1",
      write_access: "0",
      all_groups: "read",
    },
  },
  osf: {
    protocol: "oauth2",
    authorizationEndpoint: "https://accounts.osf.io/oauth2/authorize",
    tokenEndpoint: "https://accounts.osf.io/oauth2/token",
    identityEndpoint: "https://api.osf.io/v2/users/me/",
    identityIdField: "id",
    identityLabelField: "full_name",
    scope: "osf.users.profile_read",
    usesPkce: false,
  },
  figshare: {
    protocol: "oauth2",
    authorizationEndpoint: "https://figshare.com/account/applications/authorize",
    tokenEndpoint: "https://api.figshare.com/v2/token",
    identityEndpoint: "https://api.figshare.com/v2/account",
    identityIdField: "id",
    identityLabelField: "email",
    scope: "all",
    usesPkce: false,
    identityAuthorizationScheme: "token",
  },
  zenodo: {
    protocol: "oauth2",
    authorizationEndpoint: "https://zenodo.org/oauth/authorize",
    tokenEndpoint: "https://zenodo.org/oauth/token",
    identityEndpoint: "https://zenodo.org/api/me",
    identityIdField: "id",
    identityLabelField: "email",
    scope: "deposit:write deposit:actions",
    usesPkce: false,
  },
  mendeley: {
    protocol: "oauth2",
    authorizationEndpoint: "https://api.mendeley.com/oauth/authorize",
    tokenEndpoint: "https://api.mendeley.com/oauth/token",
    identityEndpoint: "https://api.mendeley.com/profiles/me",
    identityIdField: "id",
    identityLabelField: "display_name",
    scope: "all",
    usesPkce: false,
    tokenAuthentication: "client_secret_basic",
    refreshIncludesRedirectUri: true,
    identityAccept: "application/vnd.mendeley-profiles.1+json",
  },
};

export function connectionEndpoints(provider: ConnectedProviderId): ConnectionEndpoints | null {
  return CONNECTION_ENDPOINTS[provider] ?? null;
}
