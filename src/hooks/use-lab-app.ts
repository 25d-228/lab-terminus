import { useCallback, useEffect, useRef, useState } from "react"

import { toast } from "@/components/ui/toast"
import { api, jsonRequest } from "@/lib/api"
import type { FleetResponse, Folder, HostStatus, OverviewPreference, Server } from "@/types"

export type AppView = { kind: "overview" } | { kind: "server"; id: string; tab: "explorer" | "terminal" | "monitor" }

const FLEET_POLL_MS = 5000

export function useLabApp() {
  const [servers, setServers] = useState<Server[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [statuses, setStatuses] = useState<Record<string, HostStatus>>({})
  const [overviewGroup, setOverviewGroup] = useState<string | null>(null)
  const [view, setView] = useState<AppView>({ kind: "overview" })
  const [loading, setLoading] = useState(true)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [connection, setConnection] = useState("connecting…")
  const revision = useRef<number | undefined>(undefined)
  const preferenceBusy = useRef(false)
  const foldersRef = useRef(folders)
  foldersRef.current = folders

  const loadRegistry = useCallback(async () => {
    const [nextServers, nextFolders] = await Promise.all([
      api<Server[]>("/api/servers"),
      api<Folder[]>("/api/folders"),
    ])
    setServers(nextServers)
    setFolders(nextFolders)
    setOverviewGroup((current) =>
      current && !nextFolders.some((folder) => folder.key === current) ? null : current,
    )
    setView((current) =>
      current.kind === "server" && !nextServers.some((server) => server.id === current.id)
        ? { kind: "overview" }
        : current,
    )
    return { servers: nextServers, folders: nextFolders }
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([
      api<Server[]>("/api/servers"),
      api<Folder[]>("/api/folders"),
      api<OverviewPreference>("/api/preferences/overview-group"),
    ])
      .then(([nextServers, nextFolders, preference]) => {
        if (!active) return
        setServers(nextServers)
        setFolders(nextFolders)
        setOverviewGroup(
          typeof preference.group === "string" &&
            nextFolders.some((folder) => folder.key === preference.group)
            ? preference.group
            : null,
        )
      })
      .catch((error: unknown) => {
        if (active) setStartupError(String(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (loading || startupError) return
    let disposed = false
    let timer: number | undefined
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      if (!document.hidden) {
        try {
          const fleet = await api<FleetResponse>("/api/fleet")
          if (disposed) return
          const next: Record<string, HostStatus> = {}
          for (const status of fleet.servers) if (status) next[status.id] = status
          setStatuses(next)
          setConnection(
            `${fleet.servers.filter((status) => status?.online === true).length}/${fleet.servers.length} hosts online`,
          )
          if (revision.current !== undefined && revision.current !== fleet.rev) await loadRegistry()
          revision.current = fleet.rev
        } catch {
          if (!disposed) setConnection("backend unreachable")
        }
      }
      polling = false
      if (!disposed) timer = window.setTimeout(poll, FLEET_POLL_MS)
    }
    void poll()
    const onVisibility = () => {
      if (!document.hidden) {
        window.clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [loadRegistry, loading, startupError])

  const selectOverviewGroup = useCallback(async (group: string | null) => {
    if (preferenceBusy.current || group === overviewGroup) return
    preferenceBusy.current = true
    const previous = overviewGroup
    try {
      const saved = await api<OverviewPreference>(
        "/api/preferences/overview-group",
        jsonRequest("PUT", { group }),
      )
      if (saved.group !== group) throw new Error("saved group did not match the selection")
      setOverviewGroup(saved.group)
    } catch (error) {
      setOverviewGroup(previous)
      toast.add({ title: "Could not save Overview group", description: String(error), type: "error", timeout: 2600 })
    } finally {
      preferenceBusy.current = false
    }
  }, [overviewGroup])

  return {
    servers,
    folders,
    statuses,
    overviewGroup,
    selectOverviewGroup,
    view,
    setView,
    loading,
    startupError,
    connection,
    refreshRegistry: loadRegistry,
    setStatuses,
  }
}
