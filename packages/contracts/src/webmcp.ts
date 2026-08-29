import { z } from "zod";
import {
  ContractVersionSchema,
  DomainErrorCodeSchema,
  MAX_NEXT_ACTIONS,
  ProjectRevisionSchema,
} from "./envelope";

export const NextActionsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(MAX_NEXT_ACTIONS);

export const ToolSuccessSchema = <TData extends z.ZodType>(
  dataSchema: TData,
) =>
  z.object({
    ok: z.literal(true),
    contractVersion: ContractVersionSchema,
    projectRevision: ProjectRevisionSchema,
    data: dataSchema,
    nextActions: NextActionsSchema,
  });

export const ToolErrorSchema = z.object({
  ok: z.literal(false),
  contractVersion: ContractVersionSchema,
  code: DomainErrorCodeSchema,
  message: z.string().trim().min(1),
  retryable: z.boolean(),
  changed: z.boolean(),
  nextActions: NextActionsSchema,
});

export const ToolResultSchema = <TData extends z.ZodType>(
  dataSchema: TData,
) => z.union([ToolSuccessSchema(dataSchema), ToolErrorSchema]);

export type ToolError = z.infer<typeof ToolErrorSchema>;
export type ToolSuccess<TDataSchema extends z.ZodType> = z.infer<
  ReturnType<typeof ToolSuccessSchema<TDataSchema>>
>;
export type ToolResult<TDataSchema extends z.ZodType> = z.infer<
  ReturnType<typeof ToolResultSchema<TDataSchema>>
>;
