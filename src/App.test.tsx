import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { folders, json, servers, status } from "@/test/fixtures"
import { App } from "./App"

afterEach(() => vi.restoreAllMocks())

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
})
