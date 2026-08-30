/**
 * Import files are untrusted input. Keep these bounds deliberately below the
 * browser-media budget so a malformed portable manifest cannot monopolize the
 * page before the domain migration/validation boundary gets a chance to run.
 */
export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_JSON_DEPTH = 64;
export const MAX_BACKUP_JSON_NODES = 50_000;
export const MAX_BACKUP_STRING_LENGTH = 1_000_000;

export class BackupImportSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BackupImportSafetyError";
  }
}

const readFileText = async (file: File): Promise<string> => {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new BackupImportSafetyError("CueBench could not read this backup."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
};

/**
 * Iterative traversal avoids turning an adversarial nesting depth into a JS
 * call-stack failure. The domain still owns schema and aggregate validation;
 * this only constrains resource use before that work begins.
 */
const assertBoundedJsonValue = (value: unknown): void => {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) return;
    nodes += 1;
    if (nodes > MAX_BACKUP_JSON_NODES) {
      throw new BackupImportSafetyError("CueBench backup JSON contains too many values to preview safely.");
    }
    if (current.depth > MAX_BACKUP_JSON_DEPTH) {
      throw new BackupImportSafetyError("CueBench backup JSON is nested too deeply to preview safely.");
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_BACKUP_STRING_LENGTH) {
        throw new BackupImportSafetyError("CueBench backup JSON contains a string that is too large to preview safely.");
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (key.length > MAX_BACKUP_STRING_LENGTH) {
        throw new BackupImportSafetyError("CueBench backup JSON contains a string that is too large to preview safely.");
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
};

export const parseBoundedBackupJson = (text: string): unknown => {
  if (text.length > MAX_BACKUP_FILE_BYTES) {
    throw new BackupImportSafetyError("CueBench rejects backup JSON larger than 10 MB before previewing it.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BackupImportSafetyError("CueBench could not parse this backup JSON.");
  }
  assertBoundedJsonValue(parsed);
  return parsed;
};

/** Checks byte size before `File.text()` and validates JSON structure before domain import preview. */
export const readBoundedBackupFile = async (file: File): Promise<unknown> => {
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_BACKUP_FILE_BYTES) {
    throw new BackupImportSafetyError("CueBench accepts backup files up to 10 MB.");
  }
  return parseBoundedBackupJson(await readFileText(file));
};
