// @vitest-environment jsdom
import { createElement } from "react"
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ connect: vi.fn(), subscribe: vi.fn(), setAccount: vi.fn(), setStatus: vi.fn() }))
vi.mock("@/lib/host/detect", () => ({ isInHost: () => true }))
vi.mock("@/lib/host/connection", () => ({ connectToHost: mocks.connect }))
vi.mock("@/lib/host/accounts", () => ({ subscribeHostAccounts: mocks.subscribe }))
vi.mock("@/lib/web3/store/use-web3-store", () => ({ useWeb3Store: () => ({ setAccount: mocks.setAccount, setStatus: mocks.setStatus, account: { provider: "host-api", address: "old" } }) }))
import { Web3Provider } from "@/lib/web3/components/providers/web3-provider"

beforeEach(() => { vi.resetAllMocks(); mocks.connect.mockResolvedValue(true) })
afterEach(cleanup)

describe("host auto-connect ownership", () => {
  it("disposes a subscription that resolves after unmount", async () => {
    let resolve!: (stop: () => void) => void
    mocks.subscribe.mockReturnValue(new Promise((yes) => { resolve = yes }))
    const view = render(createElement(Web3Provider))
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    view.unmount()
    const stop = vi.fn()
    resolve(stop)
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    mocks.subscribe.mock.calls[0][0]([{ name: "late", address: "late" }])
    expect(mocks.setAccount).not.toHaveBeenCalled()
  })
  it("clears a persisted account when the host reports no accounts", async () => {
    mocks.subscribe.mockImplementation(async (changed) => { changed([]); return vi.fn() })
    render(createElement(Web3Provider))
    await waitFor(() => expect(mocks.setAccount).toHaveBeenCalledWith(null))
    expect(mocks.setStatus).toHaveBeenCalledWith(expect.anything(), "disconnected")
  })
  it("catches subscription setup failure and clears stale state", async () => {
    mocks.subscribe.mockRejectedValue(new Error("transport unavailable"))
    render(createElement(Web3Provider))
    await waitFor(() => expect(mocks.setAccount).toHaveBeenCalledWith(null))
  })
  it("does not subscribe if connect resolves after unmount", async () => {
    let resolve!: (value: boolean) => void
    mocks.connect.mockReturnValue(new Promise((yes) => { resolve = yes }))
    const view = render(createElement(Web3Provider))
    view.unmount()
    resolve(true)
    await new Promise((yes) => setTimeout(yes, 0))
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.setAccount).not.toHaveBeenCalled()
  })
})
