import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;
export const MAX_IDENTIFIER_LENGTH = 200 as const;
export const MAX_CURSOR_LENGTH = 256 as const;
export const MAX_TRACK_ITEMS_PER_PAGE = 100 as const;
export const MAX_NEXT_ACTIONS = 12 as const;
export const MAX_GENERATION_WARNINGS = 20 as const;

export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH);
export const CursorSchema = z.string().trim().min(1).max(MAX_CURSOR_LENGTH);

export const MediaTimeSchema = NonNegativeIntegerSchema;
export const ProjectRevisionSchema = PositiveIntegerSchema;
export const ItemRevisionSchema = PositiveIntegerSchema;

export const ExpectedProjectRevisionSchema = z.object({
  contractVersion: ContractVersionSchema,
  expectedProjectRevision: ProjectRevisionSchema,
});

export const ExpectedRevisionSchema = ExpectedProjectRevisionSchema.extend({
  expectedItemRevision: ItemRevisionSchema,
});

export const DomainErrorCodeSchema = z.enum([
  "UNSUPPORTED_MEDIA",
  "INVALID_MEDIA",
  "FILE_SIZE_LIMIT_EXCEEDED",
  "DURATION_LIMIT_EXCEEDED",
  "STORAGE_INSUFFICIENT",
  "TURNSTILE_SESSION_FAILED",
  "QUOTA_EXCEEDED",
  "SPEND_BREAKER_OPEN",
  "UPLOAD_EXPIRED",
  "UPLOAD_OWNERSHIP_MISMATCH",
  "GENERATION_STAGE_FAILED",
  "GENERATION_CANCELLED",
  "STALE_PROJECT",
  "STALE_ITEM",
  "STALE_SELECTION",
  "STALE_RUN",
  "CONFIRMATION_DECLINED",
  "TARGET_TRACK_LEASE_CONFLICT",
  "VALIDATION_BLOCKER",
  "CERTIFICATION_OUT_OF_DATE",
  "EXPORT_ROUND_TRIP_MISMATCH",
  "BACKUP_SCHEMA_UNSUPPORTED",
  "MEDIA_HASH_MISMATCH",
  "RECOVERY_ARTIFACT_EXPIRED",
  "HUMAN_AUTHORITY_REQUIRED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
]);

export type ContractVersion = z.infer<typeof ContractVersionSchema>;
export type MediaTime = z.infer<typeof MediaTimeSchema>;
export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;
export type ItemRevision = z.infer<typeof ItemRevisionSchema>;
export type ExpectedProjectRevision = z.infer<
  typeof ExpectedProjectRevisionSchema
>;
export type ExpectedRevision = z.infer<typeof ExpectedRevisionSchema>;
export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;
