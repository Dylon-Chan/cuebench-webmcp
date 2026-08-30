import { describe, expect, it, vi } from "vitest";
import {
  MAX_BACKUP_FILE_BYTES,
  parseBoundedBackupJson,
  readBoundedBackupFile,
} from "./backup-import-safety";

describe("backup import file safety", () => {
  it("rejects an oversized file before asking the browser to read its text", async () => {
    const text = vi.fn(async () => "{}");
    const oversized = { size: MAX_BACKUP_FILE_BYTES + 1, text } as unknown as File;

    await expect(readBoundedBackupFile(oversized)).rejects.toThrow(/10 MB/i);
    expect(text).not.toHaveBeenCalled();
  });

  it("bounds nested JSON before it reaches the domain import preview", () => {
    let value: unknown = { leaf: true };
    for (let index = 0; index < 70; index += 1) value = { next: value };

    expect(() => parseBoundedBackupJson(JSON.stringify(value))).toThrow(/nested/i);
  });

  it("bounds an oversized property name before it reaches the domain import preview", () => {
    const oversizedKey = "x".repeat(1_000_001);

    expect(() => parseBoundedBackupJson(JSON.stringify({ [oversizedKey]: "small value" }))).toThrow(/string/i);
  });

  it("retains a safely parsed portable JSON value for the preview boundary", async () => {
    const file = new File([JSON.stringify({ schemaVersion: 2, project: { title: "Future" } })], "future.cuebench.json", {
      type: "application/json",
    });

    await expect(readBoundedBackupFile(file)).resolves.toEqual({ schemaVersion: 2, project: { title: "Future" } });
  });
});
