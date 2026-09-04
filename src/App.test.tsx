import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const terminalMocks = vi.hoisted(() => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: "" }
    private data?: (value: string) => void
    private keyHandler?: (event: KeyboardEvent) => boolean

    loadAddon() {}
    writeln() {}
    write() {}
    focus() {}
    clear() {}
    dispose() {}
    onResize() {}
    onData(run: (value: string) => void) {
      this.data = run
    }
    attachCustomKeyEventHandler(run: (event: KeyboardEvent) => boolean) {
      this.keyHandler = run
    }
    open(wrap: HTMLDivElement) {
      wrap.addEventListener("keydown", (event) => {
        if (this.keyHandler?.(event) === false) return
        if (event.ctrlKey && event.key.toLowerCase() === "b") this.data?.("\u0002")
      })
    }
  }
  class Addon {
    fit() {}
    findNext() {}
    findPrevious() {}
  }
  return { MockTerminal, Addon }
})

vi.mock("@xterm/xterm", () => ({ Terminal: terminalMocks.MockTerminal }))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: terminalMocks.Addon }))
vi.mock("@xterm/addon-search", () => ({ SearchAddon: terminalMocks.Addon }))
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: terminalMocks.Addon }))

class SocketMock {
  static OPEN = 1
  static instances: SocketMock[] = []
  readyState = SocketMock.OPEN
  binaryType = ""
  sent: unknown[] = []
  onopen?: () => void
  onmessage?: (event: MessageEvent) => void
  onclose?: () => void
  onerror?: () => void

  send(value: unknown) {
    this.sent.push(value)
  }
  close() {
    this.readyState = 3
  }
}

import { folders, json, servers, status } from "@/test/fixtures"
import type { HostStatus } from "@/types"
import { App } from "./App"

beforeEach(() => {
  localStorage.clear()
  SocketMock.instances.length = 0
  vi.stubGlobal(
    "WebSocket",
    class extends SocketMock {
      constructor() {
        super()
        SocketMock.instances.push(this)
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("App startup", () => {
  it("loads registry, preference, transfers, and fleet before presenting the live Overview", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input)
      if (path === "/api/servers") return json(servers)
      if (path === "/api/folders") return json(folders)
      if (path === "/api/preferences/overview-group") return json({ group: "lab" })
      if (path === "/api/transfers") return json({ jobs: [] })
      if (path === "/api/fleet") return json({ servers: [status()], rev: 1 })
      throw new Error(`Unexpected ${path}`)
    })
    render(<App />)
    expect(screen.getByText("Connecting to Lab Terminus…")).toBeInTheDocument()
    await screen.findByRole("heading", { name: "Hosts" })
    expect(screen.getByRole("button", { name: "Lab Servers" })).toHaveAttribute("aria-pressed", "true")
    await waitFor(() => expect(screen.getByText("1/1 hosts online")).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers", undefined)
  })

  it("does not consume Ctrl+B before terminal input receives it", async () => {
    const user = userEvent.setup()
    mockApplicationFetch()
    render(<App />)
    await screen.findByRole("heading", { name: "Hosts" })
    await openHost(user)
    await user.click(screen.getByRole("tab", { name: "Terminal" }))
    const terminal = document.querySelector(".xterm-session")!
    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    const input = SocketMock.instances[0].sent.at(-1)
    expect(ArrayBuffer.isView(input)).toBe(true)
    expect(new TextDecoder().decode(input as Uint8Array)).toBe("\u0002")
  })

  it("preserves Overview search and Explorer session state after switching away", async () => {
    const user = userEvent.setup()
    const calls = mockApplicationFetch()
    render(<App />)
    await screen.findByRole("heading", { name: "Hosts" })
    await user.type(screen.getByRole("textbox", { name: "Search hosts" }), "Exp19")
    await openHost(user)
    await screen.findByText("project")
    await user.click(screen.getByRole("button", { name: /project/ }))
    await screen.findByText("inside.txt")
    await user.click(screen.getByRole("button", { name: "Parent folder" }))
    await screen.findByText("zeta.ts")
    await user.type(screen.getByRole("textbox", { name: "Filter files" }), "zeta")
    await user.click(screen.getByText("HIDDEN"))
    await user.click(screen.getByRole("button", { name: /^SIZE/ }))
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled()

    await user.click(screen.getByRole("tab", { name: "Terminal" }))
    await user.click(screen.getByRole("tab", { name: "Explorer" }))

    await screen.findByText("zeta.ts")
    expect(screen.getByRole("textbox", { name: "Filter files" })).toHaveValue("zeta")
    expect(screen.getByRole("checkbox")).toBeChecked()
    expect(screen.getByRole("button", { name: /^SIZE/ })).toHaveTextContent("↑")
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled()
    expect(calls).toContain("GET /api/gpu1/ls?path=%2Fhome%2Falice")

    await user.click(screen.getByRole("button", { name: /^Overview/ }))
    expect(screen.getByRole("textbox", { name: "Search hosts" })).toHaveValue("Exp19")
  })

  it("isolates Explorer state and delayed responses when switching hosts", async () => {
    const user = userEvent.setup()
    let resolveOldHost!: (response: Response) => void
    let resolveNewHost!: (response: Response) => void
    const oldHostRefresh = new Promise<Response>((resolve) => {
      resolveOldHost = resolve
    })
    const newHostListing = new Promise<Response>((resolve) => {
      resolveNewHost = resolve
    })
    let oldHostLoads = 0

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input)
      if (path === "/api/servers") return json(servers)
      if (path === "/api/folders") return json(folders)
      if (path === "/api/preferences/overview-group") return json({ group: null })
      if (path === "/api/transfers") return json({ jobs: [] })
      if (path === "/api/fleet") {
        return json({ servers: [status(), status("local", { gpus: [] })], rev: 1 })
      }
      if (path === "/api/gpu1/ls") {
        oldHostLoads += 1
        if (oldHostLoads === 1) {
          return json({
            path: "/home/alice",
            entries: [
              { name: "host-a.txt", isdir: false, size: 1, mtime: 1 },
            ],
          })
        }
        return oldHostRefresh
      }
      if (path === "/api/local/ls") return newHostListing
      throw new Error(`Unexpected ${path}`)
    })

    render(<App />)
    await screen.findByRole("heading", { name: "Hosts" })
    await user.click(screen.getByRole("button", { name: /Exp19/ }))
    await screen.findByText("host-a.txt")
    await user.type(screen.getByRole("textbox", { name: "Filter files" }), "host-a")
    await user.click(screen.getByRole("button", { name: "Refresh" }))

    await user.click(screen.getByRole("button", { name: "This Machine 1" }))
    await user.click(screen.getByRole("button", { name: /Ubuntu/ }))

    expect(screen.queryByText("host-a.txt")).not.toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Filter files" })).toHaveValue("")
    resolveOldHost(
      json({
        path: "/stale",
        entries: [{ name: "stale-a.txt", isdir: false, size: 1, mtime: 2 }],
      }),
    )
    await act(() => Promise.resolve())
    expect(screen.queryByText("stale-a.txt")).not.toBeInTheDocument()

    resolveNewHost(
      json({
        path: "/local",
        entries: [{ name: "host-b.txt", isdir: false, size: 1, mtime: 3 }],
      }),
    )
    await screen.findByText("host-b.txt")
    expect(screen.queryByText("stale-a.txt")).not.toBeInTheDocument()
  })

  it("submits every file in an accepted upload batch after leaving Explorer", async () => {
    const user = userEvent.setup()
    let resolveFirstUpload!: (response: Response) => void
    const firstUpload = new Promise<Response>((resolve) => {
      resolveFirstUpload = resolve
    })
    const uploaded: string[] = []

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input)
      if (path === "/api/servers") return json(servers)
      if (path === "/api/folders") return json(folders)
      if (path === "/api/preferences/overview-group") return json({ group: null })
      if (path === "/api/transfers") return json({ jobs: [] })
      if (path === "/api/fleet") return json({ servers: [status()], rev: 1 })
      if (path === "/api/gpu1/ls") {
        return json({ path: "/home/alice", entries: [] })
      }
      if (path.startsWith("/api/gpu1/upload")) {
        uploaded.push(path)
        if (uploaded.length === 1) return firstUpload
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected ${init?.method || "GET"} ${path}`)
    })

    const { container } = render(<App />)
    await screen.findByRole("heading", { name: "Hosts" })
    await openHost(user)
    await screen.findByText(/Empty folder/)
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(picker, {
      target: {
        files: [
          new File(["first"], "first.txt", { type: "text/plain" }),
          new File(["second"], "second.txt", { type: "text/plain" }),
        ],
      },
    })
    await waitFor(() => expect(uploaded).toHaveLength(1))

    await user.click(screen.getByRole("button", { name: "Close transfers" }))
    await user.click(await screen.findByRole("tab", { name: "Terminal" }))
    resolveFirstUpload(new Response(null, { status: 200 }))

    await waitFor(() => expect(uploaded).toHaveLength(2))
    expect(uploaded[0]).toContain("name=first.txt")
    expect(uploaded[1]).toContain("name=second.txt")
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("updates sidebar and active-host state without changing the current view", async () => {
    const user = userEvent.setup()
    let fleetStatus: HostStatus | undefined = status("gpu1", {
      gpus: [{ ...status().gpus[0], util: 49 }],
    })
    mockApplicationFetch(() => fleetStatus)
    render(<App />)
    await screen.findByRole("heading", { name: "Hosts" })
    await waitFor(() => expect(screen.getByText("1/1 hosts online")).toBeInTheDocument())
    await openHost(user)
    await screen.findByText("project")

    const hostButton = [...document.querySelectorAll<HTMLButtonElement>(
      '[data-sidebar="menu-button"]',
    )].find((button) => button.textContent?.includes("Exp19"))!
    const hostHeader = screen
      .getByText(/^alice@10\.0\.0\.1:22/)
      .closest<HTMLElement>('[data-slot="card"]')!
    expect(within(hostButton).getByLabelText("Machine status: online")).toHaveClass(
      "sr-only",
    )
    expect(within(hostHeader).getByLabelText("Machine status: online")).toHaveClass(
      "sr-only",
    )
    expect(hostButton.querySelector('[data-gpu-utilization="49"]')).toHaveClass(
      "text-blue-700",
    )
    expect(hostHeader.querySelector('[data-gpu-utilization="49"]')).toHaveClass(
      "text-blue-700",
    )

    fleetStatus = status("gpu1", {
      gpus: [{ ...status().gpus[0], util: 70 }],
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() =>
      expect(hostButton.querySelector('[data-gpu-utilization="70"]')).toHaveClass(
        "text-orange-700",
      ),
    )
    expect(hostHeader.querySelector('[data-gpu-utilization="70"]')).toHaveClass(
      "text-orange-700",
    )
    expect(screen.getByRole("tab", { name: "Explorer" })).toHaveAttribute(
      "aria-selected",
      "true",
    )

    fleetStatus = status("gpu1", { online: false, error: "offline" })
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() =>
      expect(
        within(hostButton).getByLabelText("Machine status: offline"),
      ).toBeVisible(),
    )
    expect(
      within(hostHeader).getByLabelText("Machine status: offline"),
    ).toBeVisible()
    expect(within(hostHeader).queryByText(/GPU ·/)).not.toBeInTheDocument()

    fleetStatus = undefined
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() =>
      expect(
        within(hostButton).getByLabelText("Machine status: connecting"),
      ).not.toHaveClass("sr-only"),
    )
    expect(
      within(hostHeader).getByLabelText("Machine status: connecting"),
    ).not.toHaveClass("sr-only")

    fleetStatus = status("gpu1", {
      gpus: [{ ...status().gpus[0], util: 5 }],
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() => expect(within(hostButton).getByText("FREE")).toBeVisible())
    expect(
      within(hostButton).getByLabelText("Machine status: online"),
    ).not.toHaveClass("sr-only")
    expect(within(hostHeader).getByLabelText("Machine status: online")).toHaveClass(
      "sr-only",
    )

    fleetStatus = status("gpu1", {
      gpus: [],
      ncpu: 32,
      up: "2 days",
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await within(hostHeader).findByText(/up 2 days/)
    expect(within(hostHeader).getByText(/32 cores · load/)).toBeVisible()
    expect(
      within(hostButton).getByLabelText("Machine status: online"),
    ).not.toHaveClass("sr-only")
    expect(
      within(hostHeader).getByLabelText("Machine status: online"),
    ).not.toHaveClass("sr-only")
    expect(screen.getByRole("tab", { name: "Explorer" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })
})

function mockApplicationFetch(currentStatus: () => HostStatus | undefined = status) {
  const calls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input)
    calls.push(`${init?.method || "GET"} ${path}`)
    if (path === "/api/servers") return json(servers)
    if (path === "/api/folders") return json(folders)
    if (path === "/api/preferences/overview-group") return json({ group: "lab" })
    if (path === "/api/transfers") return json({ jobs: [] })
    if (path === "/api/fleet") {
      const nextStatus = currentStatus()
      return json({ servers: nextStatus ? [nextStatus] : [], rev: 1 })
    }
    if (path === "/api/gpu1/ls") {
      return json({
        path: "/home/alice",
        parent: "/home",
        entries: [
          { name: "project", isdir: true, size: 0, mtime: 10 },
          { name: "zeta.ts", isdir: false, size: 20, mtime: 20 },
        ],
      })
    }
    if (path === "/api/gpu1/ls?path=%2Fhome%2Falice%2Fproject") {
      return json({
        path: "/home/alice/project",
        parent: "/home/alice",
        entries: [{ name: "inside.txt", isdir: false, size: 1, mtime: 30 }],
      })
    }
    if (path === "/api/gpu1/ls?path=%2Fhome%2Falice") {
      return json({
        path: "/home/alice",
        parent: "/home",
        entries: [
          { name: "project", isdir: true, size: 0, mtime: 10 },
          { name: "zeta.ts", isdir: false, size: 20, mtime: 20 },
        ],
      })
    }
    throw new Error(`Unexpected ${path}`)
  })
  return calls
}

async function openHost(user: ReturnType<typeof userEvent.setup>) {
  let hostButton = [...document.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]')]
    .find((button) => button.textContent?.includes("Exp19"))
  if (!hostButton) {
    await user.click(screen.getByRole("button", { name: "Lab Servers 1" }))
    hostButton = [...document.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]')]
      .find((button) => button.textContent?.includes("Exp19"))
  }
  if (!hostButton) throw new Error("Sidebar host button not found")
  await user.click(hostButton)
}
