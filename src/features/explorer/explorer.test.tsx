import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { json, servers } from "@/test/fixtures"
import { createExplorerSessionState, Explorer } from "./explorer"

afterEach(() => vi.restoreAllMocks())

describe("Explorer", () => {
  it("loads an authoritative path, filters, sorts, selects, mutates, and uploads dropped files", async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input); calls.push(`${init?.method || "GET"} ${path}`)
      if (path.includes("/ls")) return json({ path: "/home/alice", parent: "/home", entries: [
        { name: "src", isdir: true, size: 0, mtime: 10 },
        { name: "zeta.ts", isdir: false, size: 20, mtime: 20 },
        { name: ".secret", isdir: false, size: 2, mtime: 30 },
      ] })
      if (path.includes("/fs")) return json({ ok: true })
      if (path.includes("/upload")) return new Response(null, { status: 200 })
      throw new Error(`Unexpected ${path}`)
    })
    const onTransfersOpen = vi.fn()
    const { container } = render(
      <ExplorerHarness server={servers[0]} onTransfersOpen={onTransfersOpen} />,
    )
    await screen.findByText("zeta.ts")
    expect(screen.queryByText(".secret")).not.toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Filter files" }), "zeta")
    expect(screen.queryByText("src")).not.toBeInTheDocument()
    await user.clear(screen.getByRole("textbox", { name: "Filter files" }))
    await user.click(screen.getByRole("button", { name: /zeta.ts/ }))
    expect(screen.getByRole("heading", { name: "zeta.ts" })).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByRole("button", { name: /zeta.ts/ }))
    await user.click(await screen.findByText("Rename…"))
    const rename = screen.getByRole("textbox")
    await user.clear(rename); await user.type(rename, "renamed.ts"); await user.click(screen.getByRole("button", { name: "OK" }))
    await waitFor(() => expect(calls.some((call) => call === "POST /api/gpu1/fs")).toBe(true))
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    fireEvent.dragOver(container.firstElementChild!, { dataTransfer: { files: [file], types: ["Files"] } })
    fireEvent.drop(container.firstElementChild!, { dataTransfer: { files: [file], types: ["Files"] } })
    await waitFor(() => expect(calls.some((call) => call.includes("POST /api/gpu1/upload"))).toBe(true))
    expect(onTransfersOpen).toHaveBeenCalled()
  })

  it("rejects a stale directory response after the active host changes", async () => {
    let resolveOld!: (value: Response) => void
    const old = new Promise<Response>((resolve) => { resolveOld = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).includes("gpu1") ? old : Promise.resolve(json({ path: "/local", entries: [] })))
    const { rerender } = render(<ExplorerHarness server={servers[0]} />)
    rerender(<ExplorerHarness server={servers[1]} />)
    await screen.findByText(/Empty folder/)
    resolveOld(json({ path: "/wrong", entries: [{ name: "stale.txt", isdir: false, size: 1, mtime: 1 }] }))
    await Promise.resolve()
    expect(screen.queryByText("stale.txt")).not.toBeInTheDocument()
    expect(screen.getByText("local")).toBeInTheDocument()
  })
})

function ExplorerHarness({
  server,
  onTransfersOpen = vi.fn(),
}: {
  server: (typeof servers)[number]
  onTransfersOpen?: () => void
}) {
  const [session, setSession] = useState(createExplorerSessionState)
  return (
    <Explorer
      server={server}
      servers={servers}
      session={session}
      onSessionChange={setSession}
      onOpenTerminal={vi.fn()}
      onTransfersOpen={onTransfersOpen}
    />
  )
}
