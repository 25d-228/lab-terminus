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

  it("shows every machine state in both grid and list layouts", async () => {
    const user = userEvent.setup()
    const connectingServer = {
      ...servers[0],
      id: "pending",
      name: "Pending host",
    }

    render(
      <Overview
        servers={[...servers, connectingServer]}
        folders={folders}
        statuses={{
          gpu1: status(),
          local: status("local", { online: false, error: "offline" }),
        }}
        group={null}
        query=""
        onQueryChange={vi.fn()}
        onGroupChange={vi.fn().mockResolvedValue(undefined)}
        onOpen={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("Machine status: online")).toBeVisible()
    expect(screen.getByLabelText("Machine status: offline")).toBeVisible()
    expect(screen.getByLabelText("Machine status: connecting")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "List view" }))

    expect(screen.getByLabelText("Machine status: online")).toBeVisible()
    expect(screen.getByLabelText("Machine status: offline")).toBeVisible()
    expect(screen.getByLabelText("Machine status: connecting")).toBeVisible()
  })
})

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
