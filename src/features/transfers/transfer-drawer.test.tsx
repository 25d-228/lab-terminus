import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { TransferDrawer } from "./transfer-drawer"

describe("TransferDrawer", () => {
  it("shows newest-first progress and exposes cancel and clear boundaries", async () => {
    const user = userEvent.setup()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    render(
      <TransferDrawer
        open
        onOpenChange={vi.fn()}
        onRefresh={refresh}
        jobs={[
          {
            id: "old",
            kind: "copy",
            label: "old",
            state: "done",
            done: 10,
            total: 10,
            speed: 0,
          },
          {
            id: "new",
            kind: "upload",
            label: "new",
            state: "active",
            done: 5,
            total: 10,
            speed: 2,
          },
        ]}
      />,
    )
    const labels = screen.getAllByText(/^(new|old)$/).map((node) => node.textContent)
    expect(labels).toEqual(["new", "old"])
    await user.click(screen.getByRole("button", { name: "Cancel transfer" }))
    await user.click(screen.getByRole("button", { name: "Clear done" }))
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/new/cancel", {
      method: "POST",
    })
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/clear", { method: "POST" })
  })
})
