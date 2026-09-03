import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { json, servers, status } from "@/test/fixtures"
import { Monitor, updateNetwork } from "./monitor"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

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

  it("restores monitor labels and sorts GPU processes by descending VRAM", () => {
    render(
      <Monitor
        server={servers[0]}
        fleetStatus={status("gpu1", {
          procs: [
            { pid: 1, user: "alice", gpu: 0, mem: 1024, etime: "1m", cmd: "low-vram" },
            { pid: 2, user: "alice", gpu: 0, mem: 8192, etime: "2m", cmd: "high-vram" },
          ],
        })}
        visible
        onStatus={vi.fn()}
      />,
    )

    expect(screen.getByText("1/1 free")).toBeInTheDocument()
    expect(screen.getByText("collecting")).toBeInTheDocument()
    expect(screen.getByText("Mine · 0")).toBeInTheDocument()
    expect(screen.getByText("up 1 day")).toBeInTheDocument()
    expect(screen.getByText("% · last now")).toBeInTheDocument()
    expect(screen.getByText("% of total · 90% danger")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "GPU processes" }).parentElement).toHaveTextContent("2")
    const high = screen.getByText("high-vram")
    const low = screen.getByText("low-vram")
    expect(high.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("labels unavailable network telemetry", () => {
    render(
      <Monitor
        server={servers[0]}
        fleetStatus={status("gpu1", {
          network: { available: false, rx_bytes: 0, tx_bytes: 0, uptime_seconds: 0 },
        })}
        visible
        onStatus={vi.fn()}
      />,
    )
    expect(screen.getByText("unavailable")).toBeInTheDocument()
    expect(screen.getAllByText("Unavailable")).toHaveLength(2)
  })

  it("clears a previous pointer destination before dropping on the source", () => {
    render(<Monitor server={servers[0]} fleetStatus={status()} visible onStatus={vi.fn()} />)
    const gpuHandle = screen.getByRole("button", { name: /GPUs, position 1/ })
    const gpuSection = gpuHandle.closest("[data-monitor-section]")!
    const networkSection = document.querySelector('[data-monitor-section="network"]')!
    const dataTransfer = { effectAllowed: "", setData: vi.fn() }

    fireEvent.dragStart(gpuHandle, { dataTransfer })
    fireEvent.dragOver(networkSection, { clientY: 1, dataTransfer })
    fireEvent.dragOver(gpuSection, { clientY: 1, dataTransfer })
    fireEvent.drop(gpuSection, { dataTransfer })

    const sections = [...document.querySelectorAll("[data-monitor-section]")].map((node) =>
      node.getAttribute("data-monitor-section"),
    )
    expect(sections.slice(0, 2)).toEqual(["gpus", "network"])
    expect(screen.getByRole("status")).toHaveTextContent("")
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

  it("does not sample fleet updates while hidden and samples only on two-second monitor polls", async () => {
    vi.useFakeTimers()
    const onStatus = vi.fn()
    let monitorSample = 0
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      monitorSample += 1
      return json(
        status("gpu1", {
          network: {
            available: true,
            rx_bytes: 1000 + monitorSample * 400,
            tx_bytes: 2000 + monitorSample * 600,
            uptime_seconds: 10 + monitorSample * 2,
          },
        }),
      )
    })
    const view = render(
      <Monitor server={servers[0]} fleetStatus={status()} visible={false} onStatus={onStatus} />,
    )
    view.rerender(
      <Monitor
        server={servers[0]}
        fleetStatus={status("gpu1", { gpus: [{ ...status().gpus[0], util: 20 }] })}
        visible={false}
        onStatus={onStatus}
      />,
    )
    expect(onStatus).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    view.rerender(
      <Monitor server={servers[0]} fleetStatus={status()} visible onStatus={onStatus} />,
    )
    expect(screen.getByText("% · last now")).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText("collecting")).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(onStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText("2 samples")).toBeInTheDocument()
    expect(screen.getByText("% · last 0.1 min")).toBeInTheDocument()
    view.unmount()
    vi.useRealTimers()
  })
})
