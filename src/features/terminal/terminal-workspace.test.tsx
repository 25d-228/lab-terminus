import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const terminalMocks = vi.hoisted(() => {
  const terminals: MockTerminal[] = []
  const searches: Search[] = []
  class MockTerminal {
    cols = 80; rows = 24; options: Record<string, unknown> = {}; unicode = { activeVersion: "" }
    data?: (value: string) => void; resize?: (value: { cols: number; rows: number }) => void
    write = vi.fn(); writeln = vi.fn(); focus = vi.fn(); clear = vi.fn(); dispose = vi.fn(); open = vi.fn()
    constructor(options: Record<string, unknown>) { this.options = options; terminals.push(this) }
    loadAddon() {}; onData(run: (value: string) => void) { this.data = run }; onResize(run: (value: { cols: number; rows: number }) => void) { this.resize = run }
    attachCustomKeyEventHandler() {}
  }
  class Fit { fit = vi.fn() }
  class Search { findNext = vi.fn(); findPrevious = vi.fn(); constructor() { searches.push(this) } }
  class Unicode {}
  return { terminals, searches, MockTerminal, Fit, Search, Unicode }
})

vi.mock("@xterm/xterm", () => ({ Terminal: terminalMocks.MockTerminal }))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: terminalMocks.Fit }))
vi.mock("@xterm/addon-search", () => ({ SearchAddon: terminalMocks.Search }))
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: terminalMocks.Unicode }))

class SocketMock {
  static OPEN = 1
  static instances: SocketMock[] = []
  readyState = 0; binaryType = ""; sent: unknown[] = []; close = vi.fn(() => { this.readyState = 3 })
  onopen?: () => void; onmessage?: (event: MessageEvent) => void; onclose?: () => void; onerror?: () => void
  constructor(public url: string) { SocketMock.instances.push(this) }
  send(value: unknown) { this.sent.push(value) }
  connect() { this.readyState = 1; this.onopen?.() }
}

import { servers } from "@/test/fixtures"
import { TerminalWorkspace } from "./terminal-workspace"

beforeEach(() => {
  terminalMocks.terminals.length = 0
  terminalMocks.searches.length = 0
  SocketMock.instances.length = 0
  vi.stubGlobal("WebSocket", SocketMock)
})

describe("TerminalWorkspace", () => {
  it("forwards geometry and binary input, preserves sessions while hidden, broadcasts, searches, reconnects, and cleans up", async () => {
    const user = userEvent.setup()
    const { rerender, unmount } = render(<TerminalWorkspace server={servers[0]} visible theme="light" />)
    expect(SocketMock.instances[0].url).toContain("/api/gpu1/pty?cols=80&rows=24")
    act(() => SocketMock.instances[0].connect())
    expect(SocketMock.instances[0].sent[0]).toBe(JSON.stringify({ t: "r", c: 80, r: 24 }))
    act(() => terminalMocks.terminals[0].data?.("ls\n"))
    expect(ArrayBuffer.isView(SocketMock.instances[0].sent[1])).toBe(true)
    rerender(<TerminalWorkspace server={servers[0]} visible={false} theme="light" />)
    expect(terminalMocks.terminals[0].dispose).not.toHaveBeenCalled()
    rerender(<TerminalWorkspace server={servers[0]} visible theme="light" />)
    await user.click(screen.getByRole("button", { name: "New shell on this host" }))
    act(() => SocketMock.instances[1].connect())
    await user.click(screen.getByRole("button", { name: /Broadcast/ }))
    act(() => terminalMocks.terminals[1].data?.("pwd\n"))
    expect(ArrayBuffer.isView(SocketMock.instances[0].sent.at(-1))).toBe(true)
    expect(ArrayBuffer.isView(SocketMock.instances[1].sent.at(-1))).toBe(true)
    await user.click(screen.getByRole("button", { name: /Find/ }))
    await user.type(screen.getByRole("textbox", { name: "Search scrollback" }), "needle")
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(terminalMocks.searches[1].findNext).toHaveBeenCalledWith("needle")
    await user.click(screen.getByRole("button", { name: /Reconnect/ }))
    expect(terminalMocks.terminals[1].dispose).toHaveBeenCalledTimes(1)
    unmount()
    expect(terminalMocks.terminals[0].dispose).toHaveBeenCalledTimes(1)
    expect(SocketMock.instances.every((socket) => socket.close.mock.calls.length === 1)).toBe(true)
  })
})
