import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { folders, json, servers } from "@/test/fixtures"
import { useLabApp } from "./use-lab-app"

afterEach(() => vi.restoreAllMocks())

describe("useLabApp", () => {
  it("restores the valid preference before completing startup and retains it after a failed update", async () => {
    let preferenceWrites = 0
    let currentFolders = folders
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const path = String(input)
        if (path === "/api/servers") return json(servers)
        if (path === "/api/folders") return json(currentFolders)
        if (path === "/api/preferences/overview-group" && !init) {
          return json({ group: "this" })
        }
        if (path === "/api/preferences/overview-group") {
          preferenceWrites += 1
          return preferenceWrites === 1
            ? json({ group: "lab" })
            : new Response("disk full", { status: 500 })
        }
        if (path === "/api/fleet") return json({ servers: [], rev: 1 })
        throw new Error(`Unexpected ${path}`)
      })
    const { result, unmount } = renderHook(() => useLabApp())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/fleet", undefined)
    })
    expect(result.current.overviewGroup).toBe("this")
    await act(() => result.current.selectOverviewGroup("lab"))
    expect(result.current.overviewGroup).toBe("lab")
    await act(() => result.current.selectOverviewGroup(null))
    expect(result.current.overviewGroup).toBe("lab")
    currentFolders = folders.filter((folder) => folder.key !== "lab")
    await act(() => result.current.refreshRegistry())
    expect(result.current.overviewGroup).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/overview-group",
      expect.objectContaining({ method: "PUT" }),
    )
    unmount()
  })

  it("reports initial backend failure without fabricating registry data", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useLabApp())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.startupError).toContain("offline")
    expect(result.current.servers).toEqual([])
  })
})
