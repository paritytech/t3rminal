import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }))
vi.mock("@/lib/host/connection", () => ({ getAccountsProvider: mocks.getProvider }))
import { subscribeHostAccounts } from "@/lib/host/accounts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fixture(initialStatus?: string) {
  let status: (value: string) => void = () => {}
  let interrupt: () => void = () => {}
  const reads: ReturnType<typeof deferred<{ match: (ok: (value: { publicKey: Uint8Array }) => unknown) => unknown }>>[] = []
  const unsubscribe = vi.fn()
  const removeInterrupt = vi.fn()
  const provider = {
    getProductAccount: vi.fn(() => {
      const read = deferred<{ match: (ok: (value: { publicKey: Uint8Array }) => unknown) => unknown }>()
      reads.push(read)
      return read.promise
    }),
    getProductAccountSigner: vi.fn(() => ({})),
    subscribeAccountConnectionStatus: vi.fn((callback) => {
      status = callback
      if (initialStatus) callback(initialStatus)
      return { unsubscribe, onInterrupt: (callback: () => void) => { interrupt = callback; return removeInterrupt } }
    }),
  }
  mocks.getProvider.mockResolvedValue(provider)
  const complete = (index: number, seed: number) => reads[index].resolve({ match: (ok) => ok({ publicKey: new Uint8Array(32).fill(seed) }) })
  return { provider, reads, complete, status: (value: string) => status(value), interrupt: () => interrupt(), unsubscribe, removeInterrupt }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("window", { location: { host: "merchant.dot" } })
})

describe("host account subscriptions", () => {
  it("drops an initial lookup after disconnect", async () => {
    const host = fixture()
    const changed = vi.fn()
    const stop = await subscribeHostAccounts(changed)
    await flush()
    host.status("Disconnected")
    host.complete(0, 1)
    await flush()
    expect(changed.mock.calls).toEqual([[[]]])
    stop()
  })
  it("keeps only the newest connected lookup", async () => {
    const host = fixture()
    const changed = vi.fn()
    const stop = await subscribeHostAccounts(changed)
    await flush()
    host.status("Connected")
    await flush()
    host.complete(1, 2)
    await flush()
    host.complete(0, 1)
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0][0].publicKey).toEqual(new Uint8Array(32).fill(2))
    stop()
  })
  it("fences lookups and removes the interrupt listener on unsubscribe", async () => {
    const host = fixture()
    const changed = vi.fn()
    const stop = await subscribeHostAccounts(changed)
    await flush()
    stop()
    host.complete(0, 1)
    host.status("Connected")
    host.interrupt()
    await flush()
    expect(changed).not.toHaveBeenCalled()
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    expect(host.removeInterrupt).toHaveBeenCalledOnce()
  })
  it("clears accounts on transport interruption and drops the pending lookup", async () => {
    const host = fixture()
    const changed = vi.fn()
    const stop = await subscribeHostAccounts(changed)
    await flush()
    host.interrupt()
    host.complete(0, 1)
    await flush()
    expect(changed.mock.calls).toEqual([[[]]])
    stop()
  })
  it("honors a synchronous disconnected status during registration", async () => {
    const host = fixture("Disconnected")
    const changed = vi.fn()
    const stop = await subscribeHostAccounts(changed)
    await flush()
    host.complete(0, 1)
    await flush()
    expect(changed.mock.calls).toEqual([[[]]])
    stop()
  })
  it("reports a failed refresh and clears the current account", async () => {
    const host = fixture()
    const error = new Error("provider closed during refresh")
    mocks.getProvider.mockResolvedValueOnce(host.provider).mockRejectedValueOnce(error)
    const changed = vi.fn()
    const failed = vi.fn()
    const stop = await subscribeHostAccounts(changed, failed)
    await flush()
    expect(changed.mock.calls).toEqual([[[]]])
    expect(failed).toHaveBeenCalledWith(error)
    stop()
  })
  it("handles provider lookup rejection without an unhandled callback rejection", async () => {
    fixture()
    mocks.getProvider.mockRejectedValueOnce(new Error("unavailable"))
    await expect(subscribeHostAccounts(vi.fn())).rejects.toThrow("unavailable")
  })
})
