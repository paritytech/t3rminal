import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), alias: vi.fn() }))
vi.mock("@novasamatech/host-api-wrapper", () => ({ hostLocalStorage: { readBytes: mocks.read, writeJSON: mocks.write } }))
vi.mock("@/lib/host/connection", () => ({ getAccountsProvider: async () => ({ getProductAccountAlias: mocks.alias }) }))
vi.mock("@/lib/host/detect", () => ({ isInHost: () => true }))
vi.mock("@/lib/host/provider", () => ({ PASEO_INDIVIDUALITY_GENESIS: "0x00" }))
import { nacl } from "@/lib/crypto/primitives"
import { getOrCreateKeypair, loadKeypair } from "@/lib/crypto/keys"

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const seed = new Uint8Array(32).fill(3)
const pair = nacl.box.keyPair.fromSecretKey(seed)
const record = { publicKey: Buffer.from(pair.publicKey).toString("hex"), secretKey: Buffer.from(pair.secretKey).toString("hex") }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal("window", { location: { host: "merchant.dot" } })
  mocks.read.mockResolvedValue(undefined)
  mocks.write.mockResolvedValue(undefined)
  mocks.alias.mockReturnValue({ match: async (ok: (value: { alias: Uint8Array }) => unknown) => ok({ alias: seed }) })
})

describe("derived encryption cache protection", () => {
  it("stores a derived pair only when the cache is absent", async () => {
    expect(await getOrCreateKeypair()).toEqual(pair)
    expect(mocks.write).toHaveBeenCalledWith("encryption_keypair", record)
  })
  it("reuses matching cached bytes without rewriting", async () => {
    mocks.read.mockResolvedValue(encode(record))
    expect(await loadKeypair()).toEqual(pair)
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it.each(["publicKey", "secretKey"])("refuses a different cached %s without writing", async (field) => {
    mocks.read.mockResolvedValue(encode({ ...record, [field]: "04".repeat(32) }))
    await expect(getOrCreateKeypair()).rejects.toThrow("explicit key migration")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it.each([{ publicKey: "bad", secretKey: "00".repeat(32) }, {}, null, "not a keypair"])("preserves malformed cached data", async (value) => {
    mocks.read.mockResolvedValue(encode(value))
    await expect(loadKeypair()).rejects.toThrow("refusing to overwrite")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it.each([new Uint8Array(), new Uint8Array([255]), new TextEncoder().encode("{broken")])("preserves unreadable stored bytes", async (bytes) => {
    mocks.read.mockResolvedValue(bytes)
    await expect(loadKeypair()).rejects.toThrow("refusing to overwrite")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it("does not treat a failed cache read as an absent key", async () => {
    mocks.read.mockRejectedValue(new Error("storage unavailable"))
    await expect(loadKeypair()).rejects.toThrow("storage unavailable")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it("does not fall back to random keys when host alias retrieval fails", async () => {
    mocks.alias.mockReturnValue({ match: async (_ok: unknown, fail: (error: unknown) => unknown) => fail({ message: "host rejected" }) })
    await expect(getOrCreateKeypair()).rejects.toThrow("host rejected")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it("rejects unexpected alias lengths", async () => {
    mocks.alias.mockReturnValue({ match: async (ok: (value: { alias: Uint8Array }) => unknown) => ok({ alias: new Uint8Array(31) }) })
    await expect(getOrCreateKeypair()).rejects.toThrow("unexpected length")
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it("serializes concurrent cache writes and recovers after a rejected save", async () => {
    let saved: Uint8Array | undefined
    mocks.read.mockImplementation(async () => saved)
    mocks.write.mockImplementation(async (_key, value) => { await new Promise((yes) => setTimeout(yes, 5)); saved = encode(value) })
    await Promise.all([loadKeypair(), loadKeypair()])
    expect(mocks.write).toHaveBeenCalledOnce()
    mocks.read.mockRejectedValueOnce(new Error("temporary read failure"))
    await expect(loadKeypair()).rejects.toThrow("temporary read failure")
    await expect(loadKeypair()).resolves.toEqual(pair)
    expect(mocks.write).toHaveBeenCalledOnce()
  })
})
