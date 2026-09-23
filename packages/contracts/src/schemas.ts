/**
 * Runtime copies of the JSON Schema documents in ../schemas. The .json files stay the
 * documents shared with OpenAPI and the extension SDK. schemas.test.ts fails if these
 * drift from them.
 */

const commandEnvelope = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/command-envelope.schema.json",
  title: "Command envelope",
  type: "object",
  required: ["protocol_version", "request_id", "command", "args"],
  additionalProperties: false,
  properties: {
    protocol_version: {
      type: "string",
      pattern: "^\\d+\\.\\d+\\.\\d+$",
    },
    request_id: {
      type: "string",
      format: "uuid",
    },
    idempotency_key: {
      type: "string",
      format: "uuid",
    },
    workspace_id: {
      type: ["string", "null"],
    },
    command: {
      type: "string",
      pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*)+$",
      maxLength: 128,
    },
    args: {
      type: "object",
    },
    expected: {
      type: "object",
      additionalProperties: false,
      properties: {
        objects: {
          type: "array",
          maxItems: 1000,
          items: {
            type: "object",
            required: ["id", "version"],
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                format: "uuid",
              },
              version: {
                type: "integer",
                minimum: 1,
              },
              content_hash: {
                type: "string",
                pattern: "^sha256:[0-9a-f]{64}$",
              },
            },
          },
        },
      },
    },
    actor: {
      type: "object",
      required: ["kind", "id"],
      additionalProperties: false,
      properties: {
        kind: {
          enum: ["local_user", "extension", "automation"],
        },
        id: {
          type: "string",
          maxLength: 200,
        },
      },
    },
    origin: {
      type: "object",
      required: ["surface"],
      additionalProperties: false,
      properties: {
        surface: {
          enum: ["ui", "cli", "api", "extension", "importer", "ai"],
        },
        extension_id: {
          type: ["string", "null"],
          maxLength: 200,
        },
      },
    },
    dry_run: {
      type: "boolean",
    },
  },
} as const;

const error = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/error.schema.json",
  title: "Kiwi error",
  type: "object",
  required: ["code", "message", "details", "retryable", "recovery_actions", "correlation_id"],
  additionalProperties: false,
  properties: {
    code: {
      type: "string",
      pattern: "^KIWI_[A-Z0-9_]+$",
    },
    message: {
      type: "string",
      maxLength: 500,
    },
    details: {
      type: "object",
      additionalProperties: {
        type: ["string", "number", "boolean"],
      },
    },
    retryable: {
      type: "boolean",
    },
    recovery_actions: {
      type: "array",
      items: {
        type: "string",
      },
    },
    correlation_id: {
      type: "string",
    },
  },
} as const;

const commandResult = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/command-result.schema.json",
  title: "Command result",
  type: "object",
  required: ["protocol_version", "request_id", "status"],
  additionalProperties: false,
  properties: {
    protocol_version: {
      type: "string",
    },
    request_id: {
      type: "string",
      format: "uuid",
    },
    status: {
      enum: [
        "committed",
        "committed_with_projection_pending",
        "accepted_as_job",
        "no_change",
        "canceled",
        "failed",
      ],
    },
    transaction_id: {
      type: "string",
    },
    event_ids: {
      type: "array",
      items: {
        type: "string",
      },
    },
    data: {
      type: "object",
    },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
    error: {
      $ref: "https://kiwi.dev/schemas/error.schema.json",
    },
    replayed: {
      type: "boolean",
    },
  },
} as const;

const workspaceManifest = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/workspace-manifest.schema.json",
  title: "Kiwi workspace manifest",
  type: "object",
  required: ["$schema", "format_version", "workspace_id", "title", "created_at", "updated_at"],
  additionalProperties: true,
  properties: {
    $schema: {
      type: "string",
      minLength: 1,
    },
    format_version: {
      type: "string",
      pattern: "^\\d+\\.\\d+\\.\\d+$",
    },
    workspace_id: {
      type: "string",
      format: "uuid",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
    created_at: {
      type: "string",
      minLength: 20,
    },
    updated_at: {
      type: "string",
      minLength: 20,
    },
    default_locale: {
      type: "string",
      maxLength: 35,
    },
    default_time_zone: {
      type: "string",
      maxLength: 100,
    },
    enabled_profiles: {
      type: "array",
      items: {
        type: "string",
      },
    },
    required_extensions: {
      type: "array",
      items: {
        type: "object",
      },
    },
    schema_packs: {
      type: "array",
      items: {
        type: "string",
      },
    },
    sensitivity_default: {
      enum: ["public", "internal", "confidential", "restricted"],
    },
    features: {
      type: "object",
    },
  },
} as const;

const accountServiceHealth = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/account-service-health.schema.json",
  title: "Kiwi account service health",
  type: "object",
  required: ["protocol_version", "service", "status", "database", "migration_version"],
  additionalProperties: false,
  properties: {
    protocol_version: {
      const: "1.0.0",
    },
    service: {
      const: "kiwi-account",
    },
    status: {
      enum: ["ready", "unavailable"],
    },
    database: {
      enum: ["ready", "unavailable"],
    },
    migration_version: {
      type: ["string", "null"],
      pattern: "^[0-9]{4}_[a-z0-9_]+$",
    },
  },
} as const;

const accountAuth = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/account-auth.schema.json",
  title: "Kiwi account authentication message",
  $defs: {
    email: { type: "string", minLength: 1, maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 4096 },
    name: { type: "string", minLength: 1, maxLength: 80 },
    phone: { type: "string", minLength: 1, maxLength: 40 },
    code: { type: "string", minLength: 1, maxLength: 256 },
    device_name: { type: "string", minLength: 1, maxLength: 120 },
    redirect_uri: { type: "string", minLength: 1, maxLength: 500 },
    oauth_value: { type: "string", minLength: 1, maxLength: 256 },
    code_challenge: { type: "string", minLength: 1, maxLength: 128 },
    refresh_token: { type: "string", minLength: 1, maxLength: 512 },
    registration_profile: {
      type: "object",
      required: ["given_name", "family_name", "phone"],
      additionalProperties: false,
      properties: {
        given_name: { $ref: "#/$defs/name" },
        family_name: { $ref: "#/$defs/name" },
        phone: { $ref: "#/$defs/phone" },
      },
    },
    account: {
      type: "object",
      required: ["id", "email", "email_verified"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 100 },
        email: { $ref: "#/$defs/email" },
        email_verified: { const: true },
      },
    },
  },
  oneOf: [
    {
      type: "object",
      required: ["email", "email_kind", "password", "given_name", "family_name", "phone"],
      additionalProperties: false,
      properties: {
        email: { $ref: "#/$defs/email" },
        email_kind: { enum: ["personal", "institutional"] },
        password: { $ref: "#/$defs/password" },
        given_name: { $ref: "#/$defs/name" },
        family_name: { $ref: "#/$defs/name" },
        phone: { $ref: "#/$defs/phone" },
      },
    },
    {
      type: "object",
      required: ["email", "code", "device_name"],
      additionalProperties: false,
      properties: {
        email: { $ref: "#/$defs/email" },
        code: { $ref: "#/$defs/code" },
        device_name: { $ref: "#/$defs/device_name" },
      },
    },
    {
      type: "object",
      required: ["email", "password", "device_name"],
      additionalProperties: false,
      properties: {
        email: { $ref: "#/$defs/email" },
        password: { $ref: "#/$defs/password" },
        device_name: { $ref: "#/$defs/device_name" },
      },
    },
    {
      type: "object",
      required: ["email"],
      additionalProperties: false,
      properties: { email: { $ref: "#/$defs/email" } },
    },
    {
      type: "object",
      required: ["email", "code", "new_password"],
      additionalProperties: false,
      properties: {
        email: { $ref: "#/$defs/email" },
        code: { $ref: "#/$defs/code" },
        new_password: { $ref: "#/$defs/password" },
      },
    },
    {
      type: "object",
      required: ["redirect_uri", "state", "nonce", "code_challenge"],
      additionalProperties: false,
      properties: {
        provider: { enum: ["google", "orcid"] },
        registration_profile: { $ref: "#/$defs/registration_profile" },
        redirect_uri: { $ref: "#/$defs/redirect_uri" },
        state: { $ref: "#/$defs/oauth_value" },
        nonce: { $ref: "#/$defs/oauth_value" },
        code_challenge: { $ref: "#/$defs/code_challenge" },
      },
    },
    {
      type: "object",
      required: ["redirect_uri", "state", "nonce", "code_challenge", "code", "code_verifier"],
      additionalProperties: false,
      properties: {
        provider: { enum: ["google", "orcid"] },
        registration_profile: { $ref: "#/$defs/registration_profile" },
        redirect_uri: { $ref: "#/$defs/redirect_uri" },
        state: { $ref: "#/$defs/oauth_value" },
        nonce: { $ref: "#/$defs/oauth_value" },
        code_challenge: { $ref: "#/$defs/code_challenge" },
        code: { type: "string", minLength: 1, maxLength: 512 },
        code_verifier: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    {
      type: "object",
      required: ["status", "authorization_url"],
      additionalProperties: false,
      properties: {
        status: { const: "browser_required" },
        authorization_url: { type: "string", minLength: 1, maxLength: 2_048 },
      },
    },
    {
      type: "object",
      required: ["refresh_token"],
      additionalProperties: false,
      properties: { refresh_token: { $ref: "#/$defs/refresh_token" } },
    },
    {
      type: "object",
      required: ["status", "next"],
      additionalProperties: false,
      properties: {
        status: { const: "accepted" },
        next: { enum: ["verify_email", "check_email"] },
        fixture_code: { $ref: "#/$defs/code" },
      },
    },
    {
      type: "object",
      required: [
        "status",
        "account",
        "access_token",
        "expires_at",
        "refresh_token",
        "refresh_expires_at",
      ],
      additionalProperties: false,
      properties: {
        status: { const: "authenticated" },
        account: { $ref: "#/$defs/account" },
        access_token: { type: "string", minLength: 1, maxLength: 512 },
        expires_at: { type: "string", minLength: 1, maxLength: 50 },
        refresh_token: { $ref: "#/$defs/refresh_token" },
        refresh_expires_at: { type: "string", minLength: 1, maxLength: 50 },
      },
    },
    {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: { status: { enum: ["password_reset", "signed_out"] } },
    },
    {
      type: "object",
      required: ["status", "code", "message"],
      additionalProperties: false,
      properties: {
        status: { const: "error" },
        code: {
          enum: [
            "invalid_input",
            "password_rejected",
            "invalid_credentials",
            "verification_required",
            "invalid_or_expired_code",
            "rate_limited",
            "service_unavailable",
            "provider_cancelled",
            "provider_denied",
            "invalid_callback",
            "identity_link_required",
            "session_expired",
            "refresh_reuse_detected",
          ],
        },
        message: { type: "string", minLength: 1, maxLength: 500 },
        retry_after_seconds: { type: "integer", minimum: 1 },
      },
    },
  ],
} as const;

const canonicalObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/canonical-object.schema.json",
  title: "Canonical research object",
  type: "object",
  required: [
    "$schema",
    "id",
    "type",
    "schema_version",
    "title",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "version",
    "last_event_id",
    "last_transaction_id",
    "content_hash",
    "sensitivity",
    "provenance",
    "tags",
    "extensions",
  ],
  additionalProperties: true,
  properties: {
    $schema: { type: "string", format: "uri" },
    id: { type: "string", format: "uuid" },
    type: { type: "string", minLength: 1, maxLength: 100 },
    schema_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    title: { type: "string", minLength: 1, maxLength: 200 },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    created_by: { type: "string", minLength: 1, maxLength: 150 },
    updated_by: { type: "string", minLength: 1, maxLength: 150 },
    version: { type: "integer", minimum: 1 },
    last_event_id: { type: "string", format: "uuid" },
    last_transaction_id: { type: "string", format: "uuid" },
    content_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    sensitivity: { enum: ["public", "internal", "confidential", "restricted"] },
    provenance: { type: "array", maxItems: 10000 },
    tags: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 200 } },
    extensions: { type: "object", additionalProperties: true },
  },
} as const;

const canonicalRelation = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kiwi.dev/schemas/canonical-relation.schema.json",
  title: "Canonical typed relation",
  type: "object",
  required: [
    "$schema",
    "id",
    "type",
    "schema_version",
    "subject",
    "object",
    "assertion",
    "created_at",
    "created_by",
    "version",
    "last_event_id",
    "last_transaction_id",
    "content_hash",
  ],
  additionalProperties: true,
  properties: {
    $schema: { type: "string", format: "uri" },
    id: { type: "string", format: "uuid" },
    type: { type: "string", minLength: 1, maxLength: 100 },
    schema_version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    subject: {
      type: "object",
      required: ["object_id"],
      additionalProperties: true,
      properties: { object_id: { type: "string", format: "uuid" } },
    },
    object: {
      type: "object",
      required: ["object_id"],
      additionalProperties: true,
      properties: { object_id: { type: "string", format: "uuid" } },
    },
    assertion: { type: "string", minLength: 1, maxLength: 100 },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string", minLength: 1, maxLength: 150 },
    version: { type: "integer", minimum: 1 },
    last_event_id: { type: "string", format: "uuid" },
    last_transaction_id: { type: "string", format: "uuid" },
    content_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  },
} as const;

export const SCHEMAS = {
  accountAuth,
  accountServiceHealth,
  commandEnvelope,
  error,
  commandResult,
  workspaceManifest,
  canonicalObject,
  canonicalRelation,
} as const;

export const SCHEMA_FILES: Record<keyof typeof SCHEMAS, string> = {
  accountAuth: "account-auth.schema.json",
  accountServiceHealth: "account-service-health.schema.json",
  commandEnvelope: "command-envelope.schema.json",
  error: "error.schema.json",
  commandResult: "command-result.schema.json",
  workspaceManifest: "workspace-manifest.schema.json",
  canonicalObject: "canonical-object.schema.json",
  canonicalRelation: "canonical-relation.schema.json",
};
