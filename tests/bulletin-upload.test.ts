/**
 * Upload path guards for `uploadToBulletinChain`.
 *
 * Two invariants the host integration depends on:
 *  - a silent host (no `preimage_submit_response`) must surface a bounded
 *    timeout error, never an eternal hang;
 *  - the `PreimageSubmit` permission must be requested before the submit slot
 *    is used, otherwise the host drops the request.
 *
 * The host boundary is mocked so the path runs without a real Polkadot Desktop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensurePreimageSubmitPermission } from "@/lib/host/allowances";
import { uploadToBulletinChain } from "@/lib/bulletin/client";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("@/lib/host/detect", () => ({ isInHost: () => true }));
vi.mock("@/lib/host/allowances", () => ({
  claimDefaultAllowances: vi.fn().mockResolvedValue(undefined),
  ensurePreimageSubmitPermission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@novasamatech/host-api-wrapper", () => ({
  preimageManager: { submit: submitMock },
}));

const ensure = vi.mocked(ensurePreimageSubmitPermission);

beforeEach(() => {
  submitMock.mockReset();
  ensure.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("uploadToBulletinChain", () => {
  it("rejects with a timeout when the host never responds", async () => {
    submitMock.mockImplementation(() => new Promise<string>(() => {}));
    vi.useFakeTimers();

    const result = uploadToBulletinChain(new Uint8Array([1, 2, 3]));
    const assertion = expect(result).rejects.toThrow(/timed out/);

    // The submit setTimeout is only registered once the prior awaits settle;
    // pump microtasks until then, then jump past the timeout.
    for (let i = 0; i < 50 && submitMock.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(submitMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it("requests PreimageSubmit permission before submitting", async () => {
    submitMock.mockResolvedValue("0xabc");

    const result = await uploadToBulletinChain(new Uint8Array([1, 2, 3]));

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(
      submitMock.mock.invocationCallOrder[0],
    );
    expect(result.kind).toBe("preimage");
  });
});
