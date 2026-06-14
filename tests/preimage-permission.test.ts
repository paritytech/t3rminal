/**
 * Behavior of the real `ensurePreimageSubmitPermission` from
 * `lib/host/allowances.ts`: it grants the host-side `PreimageSubmit` remote
 * permission, surfaces denial and transport errors as labeled rejections, and
 * memoizes a success so the host modal opens at most once per page lifetime.
 *
 * The wrapper's `requestPermission` is mocked with a minimal neverthrow-shaped
 * stand-in exposing only the `.match(ok, err)` the function calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestPermissionMock } = vi.hoisted(() => ({ requestPermissionMock: vi.fn() }));

vi.mock("@novasamatech/host-api", () => ({ enumValue: vi.fn() }));
vi.mock("@novasamatech/host-api-wrapper", () => ({
  hostApi: {},
  requestPermission: requestPermissionMock,
}));

type PermissionResult = {
  match: (
    ok: (granted: boolean) => unknown,
    err: (e: { payload?: { reason?: string } }) => unknown,
  ) => Promise<unknown>;
};

function permissionResult(outcome: { granted: boolean } | { error: string }): PermissionResult {
  return {
    match: (ok, err) =>
      Promise.resolve(
        "error" in outcome ? err({ payload: { reason: outcome.error } }) : ok(outcome.granted),
      ),
  };
}

// Dynamic + resetModules: each case needs a fresh copy of the memoized cache.
async function loadEnsure() {
  return (await import("@/lib/host/allowances")).ensurePreimageSubmitPermission;
}

beforeEach(() => {
  vi.resetModules();
  requestPermissionMock.mockReset();
});

describe("ensurePreimageSubmitPermission", () => {
  it("requests the PreimageSubmit slot and resolves when the host grants it", async () => {
    requestPermissionMock.mockReturnValue(permissionResult({ granted: true }));

    const ensure = await loadEnsure();

    await expect(ensure()).resolves.toBeUndefined();
    expect(requestPermissionMock).toHaveBeenCalledWith({
      tag: "PreimageSubmit",
      value: undefined,
    });
  });

  it("rejects when the host denies the permission", async () => {
    requestPermissionMock.mockReturnValue(permissionResult({ granted: false }));

    const ensure = await loadEnsure();

    await expect(ensure()).rejects.toThrow(/did not grant/);
  });

  it("rejects with the host reason on a transport error", async () => {
    requestPermissionMock.mockReturnValue(permissionResult({ error: "boom" }));

    const ensure = await loadEnsure();

    await expect(ensure()).rejects.toThrow(/boom/);
  });

  it("memoizes a successful grant and does not re-prompt", async () => {
    requestPermissionMock.mockReturnValue(permissionResult({ granted: true }));

    const ensure = await loadEnsure();
    await ensure();
    await ensure();

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
  });
});
