import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SidebarProvider } from "@/components/ui/sidebar"
import { json, folders, servers } from "@/test/fixtures"
import { AppSidebar } from "./app-sidebar"
import { RegistryDialog } from "./registry-dialog"

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("registry controls", () => {
  it("validates a server and sends the typed add request", async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(servers[0]))
    const saved = vi.fn().mockResolvedValue(undefined)
    render(
      <RegistryDialog
        state={{ type: "server", folder: "lab" }}
        folders={folders}
        onClose={vi.fn()}
        onSaved={saved}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(fetchMock).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText("Name"), "New host")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/servers",
        expect.objectContaining({ method: "POST" }),
      )
    })
    expect(saved).toHaveBeenCalled()
  })

  it("opens the sidebar server context menu and confirms destructive removal", async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ok: true }))
    const refresh = vi.fn().mockResolvedValue(undefined)
    render(
      <SidebarProvider>
        <AppSidebar
          servers={servers}
          folders={folders}
          statuses={{}}
          view={{ kind: "overview" }}
          onViewChange={vi.fn()}
          onEdit={vi.fn()}
          onRefresh={refresh}
        />
      </SidebarProvider>,
    )
    await user.click(screen.getByRole("button", { name: /Lab Servers/ }))
    fireEvent.contextMenu(screen.getByRole("button", { name: /Exp19/ }))
    await user.click(await screen.findByText("Remove server"))
    expect(screen.getByText("Remove Exp19?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/servers/gpu1",
        expect.objectContaining({ method: "DELETE" }),
      )
    })
    expect(refresh).toHaveBeenCalled()
  })

  it("reveals the active host and newly added servers in persisted folders", async () => {
    localStorage.setItem(
      "lt-collapsed",
      JSON.stringify({ lab: true, this: true }),
    )
    const props = {
      folders,
      statuses: {},
      onViewChange: vi.fn(),
      onEdit: vi.fn(),
      onRefresh: vi.fn().mockResolvedValue(undefined),
    }
    const view = render(
      <SidebarProvider>
        <AppSidebar servers={servers} view={{ kind: "overview" }} {...props} />
      </SidebarProvider>,
    )
    expect(screen.queryByRole("button", { name: /Exp19/ })).not.toBeInTheDocument()

    view.rerender(
      <SidebarProvider>
        <AppSidebar
          servers={servers}
          view={{ kind: "server", id: "gpu1", tab: "explorer" }}
          {...props}
        />
      </SidebarProvider>,
    )
    expect(await screen.findByRole("button", { name: /Exp19/ })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem("lt-collapsed") ?? "{}")).toMatchObject({
      lab: false,
      this: true,
    })

    const newServer = {
      ...servers[0],
      id: "new-host",
      name: "New host",
      group: "this",
    }
    view.rerender(
      <SidebarProvider>
        <AppSidebar
          servers={[...servers, newServer]}
          view={{ kind: "overview" }}
          {...props}
        />
      </SidebarProvider>,
    )
    expect(await screen.findByRole("button", { name: /New host/ })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem("lt-collapsed") ?? "{}")).toMatchObject({
      lab: false,
      this: false,
    })
  })
})
