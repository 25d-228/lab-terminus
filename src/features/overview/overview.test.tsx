import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { folders, servers, status } from "@/test/fixtures"
import { Overview } from "./overview"

describe("Overview", () => {
  it("composes configured-folder selection with search in grid and list modes", async () => {
    const user = userEvent.setup()
    const onGroupChange = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<Overview servers={servers} folders={folders} statuses={{ gpu1: status() }} group={null} onGroupChange={onGroupChange} onOpen={vi.fn()} />)

    expect(screen.getByText(/2 machines/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Lab Servers" }))
    expect(onGroupChange).toHaveBeenCalledWith("lab")
    rerender(<Overview servers={servers} folders={folders} statuses={{ gpu1: status() }} group="lab" onGroupChange={onGroupChange} onOpen={vi.fn()} />)
    await user.type(screen.getByRole("textbox", { name: "Search hosts" }), "ubuntu")
    expect(screen.getByText(/No hosts in “Lab Servers” match/)).toBeInTheDocument()
    await user.clear(screen.getByRole("textbox", { name: "Search hosts" }))
    await user.click(screen.getByRole("button", { name: "List view" }))
    expect(localStorage.getItem("lt-ovmode")).toBe("list")
    expect(screen.getByRole("button", { name: /Exp19/ })).toBeInTheDocument()
  })
})
