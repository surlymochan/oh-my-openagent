import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { type Device, GIT_TEST_TIMEOUT, makeDevice } from "./engine-harness.test-support"
import { FakeSyncServer } from "./fake-server.test-support"
import { item, publish } from "./received-keys.test-support"

const posix = process.platform === "win32" ? test.skip : test

const devices: Device[] = []
afterEach(async () => {
  for (const d of devices.splice(0)) await d.dispose()
}, GIT_TEST_TIMEOUT)

async function settlesAndKeepsApplying(server: FakeSyncServer, b: Device): Promise<void> {
  expect(await b.engine.state()).toMatchObject({ cycle: null, paused: null })
  expect(await b.renderJournals()).toEqual([])
  await publish(server, item("after.md", "after"))
  expect(await b.engine.runCycle()).toMatchObject({ applied: 1, rejectedItems: 0 })
  expect(await b.read("after.md")).toBe("after\n")
}

posix("a FIFO at a received key's path is refused on landing and does not hang the next cycle", async () => {
  const server = new FakeSyncServer()
  const b = await makeDevice(server, "b")
  devices.push(b)
  await b.engine.runCycle()
  const made = Bun.spawn(["mkfifo", join(b.repo.root, "note.md")])
  expect(await made.exited).toBe(0)
  await publish(server, item("note.md", "from a peer"), item("ok.md", "ok"))
  expect(await b.engine.runCycle()).toMatchObject({ applied: 1, rejectedItems: 1 })
  expect(await b.read("ok.md")).toBe("ok\n")
  // The refused key stays in the item store, so the next capture meets it as a known but
  // unlisted key. The pre-fix code read the FIFO here, which blocks until a writer opens it.
  // The bounded race keeps that run from hanging the suite: it settles as a timeout instead.
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: "timed-out" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timed-out" }), 10_000)
  })
  try {
    const settled = await Promise.race([
      b.engine.runCycle().then((report) => ({ kind: "completed" as const, report })),
      timeout,
    ])
    expect(settled).toMatchObject({ kind: "completed", report: { applied: 0, rejectedItems: 0 } })
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
  expect((await lstat(join(b.repo.root, "note.md"))).isFIFO()).toBe(true)
  await settlesAndKeepsApplying(server, b)
}, GIT_TEST_TIMEOUT)
