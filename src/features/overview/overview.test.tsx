import { useState } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { folders, servers, status } from "@/test/fixtures"
import { Overview } from "./overview"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("Overview", () => {
  it("composes configured-folder selection with search in grid and list modes", async () => {
    const user = userEvent.setup()
    const onGroupChange = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <OverviewHarness group={null} onGroupChange={onGroupChange} />,
    )

    expect(screen.getByText(/2 machines/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Lab Servers" }))
    expect(onGroupChange).toHaveBeenCalledWith("lab")
    rerender(<OverviewHarness group="lab" onGroupChange={onGroupChange} />)
    await user.type(screen.getByRole("textbox", { name: "Search hosts" }), "ubuntu")
    expect(screen.getByText(/No hosts in “Lab Servers” match/)).toBeInTheDocument()
    await user.clear(screen.getByRole("textbox", { name: "Search hosts" }))
    await user.click(screen.getByRole("button", { name: "List view" }))
    expect(localStorage.getItem("lt-ovmode")).toBe("list")
    expect(screen.getByRole("button", { name: /Exp19/ })).toBeInTheDocument()
  })

  it("keeps the complete host address available in grid and list layouts", async () => {
    const user = userEvent.setup()
    const longAddress = "researcher@compute-node-with-a-very-long-name.internal.example:2222"
    const longHost = {
      ...servers[0],
      host: "compute-node-with-a-very-long-name.internal.example",
      port: 2222,
      user: "researcher",
    }
    const view = render(
      <Overview
        servers={[longHost]}
        folders={folders}
        statuses={{ gpu1: status() }}
        group={null}
        query=""
        onQueryChange={vi.fn()}
        onGroupChange={vi.fn().mockResolvedValue(undefined)}
        onOpen={vi.fn()}
      />,
    )

    expect(screen.getByText(longAddress)).toBeVisible()
    expect(screen.getByText(longAddress)).toHaveAttribute(
      "data-full-address",
      longAddress,
    )

    await user.click(screen.getByRole("button", { name: "List view" }))
    expect(screen.getByText(longAddress)).toBeVisible()
    view.unmount()
  })

  it("hides only redundant online state in grid and list layouts", async () => {
    const user = userEvent.setup()
    const connectingServer = {
      ...servers[0],
      id: "pending",
      name: "Pending host",
    }
    const cpuServer = {
      ...servers[0],
      id: "cpu",
      name: "CPU host",
      gpuLabel: "",
    }

    render(
      <Overview
        servers={[...servers, connectingServer, cpuServer]}
        folders={folders}
        statuses={{
          gpu1: status(),
          local: status("local", { online: false, error: "offline" }),
          cpu: status("cpu", { gpus: [] }),
        }}
        group={null}
        query=""
        onQueryChange={vi.fn()}
        onGroupChange={vi.fn().mockResolvedValue(undefined)}
        onOpen={vi.fn()}
      />,
    )

    expect(machineStateFor("Exp19")).toHaveClass("sr-only")
    expect(machineStateFor("CPU host")).not.toHaveClass("sr-only")
    expect(machineStateFor("Ubuntu")).toHaveTextContent("offline")
    expect(machineStateFor("Pending host")).toHaveTextContent("connecting")
    expect(document.querySelector('[data-machine-state] svg')).not.toBeInTheDocument()
    expect(screen.getByText("5%")).toHaveClass("text-blue-700")
    for (const diskPercentage of screen.getAllByText("disk 25%", { exact: false })) {
      expect(diskPercentage).not.toHaveAttribute("data-gpu-utilization")
    }

    await user.click(screen.getByRole("button", { name: "List view" }))

    expect(machineStateFor("Exp19", "tr")).toHaveClass("sr-only")
    expect(machineStateFor("CPU host", "tr")).not.toHaveClass("sr-only")
    expect(machineStateFor("Ubuntu", "tr")).toHaveTextContent("offline")
    expect(machineStateFor("Pending host", "tr")).toHaveTextContent("connecting")
    expect(screen.getByText("5%")).toHaveClass("text-blue-700")
  })
})

function machineStateFor(name: string, container = '[data-slot="card"]') {
  const surface = screen.getByText(name).closest<HTMLElement>(container)!
  return surface.querySelector<HTMLElement>("[data-machine-state]")!
}

function OverviewHarness({
  group,
  onGroupChange,
}: {
  group: string | null
  onGroupChange: (group: string | null) => Promise<void>
}) {
  const [query, setQuery] = useState("")
  return (
    <Overview
      servers={servers}
      folders={folders}
      statuses={{ gpu1: status() }}
      group={group}
      query={query}
      onQueryChange={setQuery}
      onGroupChange={onGroupChange}
      onOpen={vi.fn()}
    />
  )
}
