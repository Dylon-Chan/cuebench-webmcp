import type { DomainErrorCode } from "@cuebench/contracts";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
): DomainError => ({ code, message });
