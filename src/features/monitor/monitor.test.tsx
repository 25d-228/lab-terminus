import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { json, servers, status } from "@/test/fixtures"
import { Monitor, updateNetwork } from "./monitor"

afterEach(() => vi.restoreAllMocks())

describe("Monitor", () => {
  it("changes process scope, ignores a stale response, and reorders sections from the keyboard", async () => {
    const user = userEvent.setup()
    let resolveOthers!: (response: Response) => void
    const others = new Promise<Response>((resolve) => { resolveOthers = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).includes("others") ? others : Promise.resolve(json(status("gpu1", { top_procs: [{ pid: 7, user: "root", cpu_pct: 1, memory_pct: 2, resident_bytes: 3, elapsed: "1m", command: "root-task" }] }))))
    render(<Monitor server={servers[0]} fleetStatus={status()} visible onStatus={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Show Others processes" }))
    await user.click(screen.getByRole("button", { name: "Show Root processes" }))
    await screen.findByText("root-task")
    resolveOthers(json(status("gpu1", { top_procs: [{ pid: 8, user: "bob", cpu_pct: 1, memory_pct: 2, resident_bytes: 3, elapsed: "1m", command: "stale-task" }] })))
    await act(() => Promise.resolve())
    expect(screen.queryByText("stale-task")).not.toBeInTheDocument()
    const gpuHandle = screen.getByRole("button", { name: /GPUs, position 1/ })
    gpuHandle.focus()
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}")
    expect(screen.getByRole("status")).toHaveTextContent("GPUs moved to position 2")
    expect(gpuHandle).toHaveFocus()
    const sections = [...document.querySelectorAll("[data-monitor-section]")].map((node) => node.getAttribute("data-monitor-section"))
    expect(sections.slice(0, 2)).toEqual(["network", "gpus"])
  })

  it("calculates valid network deltas and resets on rollback", () => {
    const states: Record<string, { sample: { rx: number; tx: number; uptime: number } | null; rate: { rx: number; tx: number } | null; rx: number[]; tx: number[] }> = {}
    updateNetwork(states, status("gpu1", { network: { available: true, rx_bytes: 100, tx_bytes: 200, uptime_seconds: 10 } }))
    updateNetwork(states, status("gpu1", { network: { available: true, rx_bytes: 300, tx_bytes: 500, uptime_seconds: 20 } }))
    expect(states.gpu1.rate).toEqual({ rx: 20, tx: 30 })
    updateNetwork(states, status("gpu1", { network: { available: true, rx_bytes: 1, tx_bytes: 1, uptime_seconds: 21 } }))
    expect(states.gpu1.rate).toBeNull()
    expect(states.gpu1.rx).toEqual([])
  })

  it("waits for a slow monitor request before scheduling the next poll", async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending)
    const view = render(<Monitor server={servers[0]} fleetStatus={status()} visible onStatus={vi.fn()} />)
    await act(() => vi.advanceTimersByTimeAsync(10000))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolve(json(status()))
    await act(() => Promise.resolve())
    view.unmount()
    vi.useRealTimers()
  })
})
