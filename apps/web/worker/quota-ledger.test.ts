import { describe, expect, it } from "vitest";
import { InMemoryQuotaLedger } from "./quota-ledger";
import type { AnonymousQuotaLimits } from "./env";

const quotas = (overrides: Partial<AnonymousQuotaLimits> = {}): AnonymousQuotaLimits => ({
  sessionMediaMinutes: 90,
  ipMediaMinutes: 90,
  sessionGenerations: 2,
  ipGenerations: 3,
  sessionTts: 2,
  ipTts: 3,
  globalSpendLimitCents: 100,
  pendingSessionBytes: 1_000,
  pendingIpBytes: 2_000,
  pendingSessionOperations: 100,
  pendingIpOperations: 200,
  ...overrides,
});

describe("anonymous quota reservation ledger", () => {
  it("keeps no-byte upload reservations out of the committed 90-minute media window", async () => {
    const ledger = new InMemoryQuotaLedger();
    const limits = quotas();

    for (let index = 0; index < 90; index += 1) {
      await expect(ledger.reserveUpload({
        sessionKey: "salted-session",
        ipKey: "salted-ip",
        reservationKey: `salted-reservation-${index}`,
        byteLength: 1,
        nowMs: 1_000,
        expiresAtMs: 10_000,
        quotas: limits,
      })).resolves.toEqual({ accepted: true, existing: false });
    }

    await expect(ledger.commitMedia({
      reservationKey: "salted-reservation-0",
      actualByteLength: 1,
      actualDurationMs: 90 * 60_000,
      nowMs: 2_000,
      quotas: limits,
    })).resolves.toEqual({ accepted: true, committedMinutes: 90 });
  });

  it("bounds pending reservations by salted session and IP bytes, then releases them on cancellation", async () => {
    const ledger = new InMemoryQuotaLedger();
    const limits = quotas({ pendingSessionBytes: 10, pendingIpBytes: 12, pendingSessionOperations: 2, pendingIpOperations: 2 });

    await expect(ledger.reserveUpload({
      sessionKey: "salted-session-a",
      ipKey: "salted-ip",
      reservationKey: "salted-a",
      byteLength: 8,
      nowMs: 1_000,
      expiresAtMs: 10_000,
      quotas: limits,
    })).resolves.toEqual({ accepted: true, existing: false });
    await expect(ledger.reserveUpload({
      sessionKey: "salted-session-b",
      ipKey: "salted-ip",
      reservationKey: "salted-b",
      byteLength: 5,
      nowMs: 1_000,
      expiresAtMs: 10_000,
      quotas: limits,
    })).resolves.toEqual({ accepted: false, code: "PENDING_IP_LIMIT" });
    await expect(ledger.releaseUploadReservation({ reservationKey: "salted-a", nowMs: 1_001 })).resolves.toBe(true);
    await expect(ledger.reserveUpload({
      sessionKey: "salted-session-b",
      ipKey: "salted-ip",
      reservationKey: "salted-b",
      byteLength: 5,
      nowMs: 1_002,
      expiresAtMs: 10_000,
      quotas: limits,
    })).resolves.toEqual({ accepted: true, existing: false });
  });

  it("commits actual media idempotently after probe reconciliation", async () => {
    const ledger = new InMemoryQuotaLedger();
    const limits = quotas();
    await ledger.reserveUpload({
      sessionKey: "salted-session",
      ipKey: "salted-ip",
      reservationKey: "salted-operation",
      byteLength: 5,
      nowMs: 1_000,
      expiresAtMs: 10_000,
      quotas: limits,
    });

    const first = await ledger.commitMedia({ reservationKey: "salted-operation", actualByteLength: 5, actualDurationMs: 61_000, nowMs: 2_000, quotas: limits });
    const replay = await ledger.commitMedia({ reservationKey: "salted-operation", actualByteLength: 5, actualDurationMs: 61_000, nowMs: 2_001, quotas: limits });

    expect(first).toEqual({ accepted: true, committedMinutes: 2 });
    expect(replay).toEqual(first);
  });

  it("applies session, IP, and global-breaker checks to idempotent generation and TTS reservations", async () => {
    const ledger = new InMemoryQuotaLedger();
    const limits = quotas({ sessionGenerations: 2, ipGenerations: 2, sessionTts: 1, ipTts: 2 });

    expect(await ledger.reserveGeneration({ sessionKey: "salted-a", ipKey: "salted-ip", usageKey: "generation-a", nowMs: 1_000, quotas: limits })).toBe(true);
    expect(await ledger.reserveGeneration({ sessionKey: "salted-a", ipKey: "salted-ip", usageKey: "generation-a", nowMs: 1_001, quotas: limits })).toBe(true);
    expect(await ledger.reserveGeneration({ sessionKey: "salted-b", ipKey: "salted-ip", usageKey: "generation-b", nowMs: 1_002, quotas: limits })).toBe(true);
    expect(await ledger.reserveGeneration({ sessionKey: "salted-c", ipKey: "salted-ip", usageKey: "generation-c", nowMs: 1_003, quotas: limits })).toBe(false);
    expect(await ledger.reserveTts({ sessionKey: "salted-a", ipKey: "salted-ip", usageKey: "tts-a", nowMs: 1_004, quotas: limits })).toBe(true);
    expect(await ledger.reserveTts({ sessionKey: "salted-a", ipKey: "salted-ip", usageKey: "tts-b", nowMs: 1_005, quotas: limits })).toBe(false);

    await expect(ledger.recordSpend({ spendKey: "provider-charge-a", cents: 100, nowMs: 1_006, globalSpendLimitCents: limits.globalSpendLimitCents })).resolves.toEqual({ breakerOpen: true, spendCents: 100 });
    await expect(ledger.recordSpend({ spendKey: "provider-charge-a", cents: 100, nowMs: 1_007, globalSpendLimitCents: limits.globalSpendLimitCents })).resolves.toEqual({ breakerOpen: true, spendCents: 100 });
    expect(await ledger.reserveTts({ sessionKey: "salted-b", ipKey: "other-salted-ip", usageKey: "tts-after-breaker", nowMs: 1_007, quotas: limits })).toBe(false);
  });
});
