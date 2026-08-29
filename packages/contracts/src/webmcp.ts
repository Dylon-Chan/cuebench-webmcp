import { z } from "zod";
import {
  CONTRACT_VERSION,
  ContractVersionSchema,
  DomainErrorCodeSchema,
  ProjectRevisionSchema,
} from "./envelope";

export const NextActionsSchema = z.array(z.string().trim().min(1));

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
export type ToolSuccess<TData> = {
  ok: true;
  contractVersion: typeof CONTRACT_VERSION;
  projectRevision: number;
  data: TData;
  nextActions: string[];
};
export type ToolResult<TData> = ToolSuccess<TData> | ToolError;
