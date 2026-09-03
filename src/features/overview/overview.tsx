import { useMemo, useState } from "react"
import { Grid2X2, List, Server as ServerIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { bytes, gpuSummary, percent } from "@/lib/format"
import type { Folder, HostStatus, Server } from "@/types"

interface OverviewProps {
  servers: Server[]
  folders: Folder[]
  statuses: Record<string, HostStatus>
  group: string | null
  query: string
  onQueryChange: (query: string) => void
  onGroupChange: (group: string | null) => Promise<void>
  onOpen: (id: string) => void
}

export function Overview({
  servers,
  folders,
  statuses,
  group,
  query,
  onQueryChange,
  onGroupChange,
  onOpen,
}: OverviewProps) {
  const [mode, setMode] = useState<"grid" | "list">(() =>
    localStorage.getItem("lt-ovmode") === "list" ? "list" : "grid",
  )
  const filtered = useMemo(() => {
    const needle = query.toLowerCase()
    return servers.filter(
      (server) =>
        (group === null || (server.group || "lab") === group) &&
        (!needle ||
          `${server.name} ${server.host ?? ""} ${server.gpuLabel ?? ""}`
            .toLowerCase()
            .includes(needle)),
    )
  }, [group, query, servers])
  const selectedFolder = folders.find((folder) => folder.key === group)
  const count =
    filtered.length === servers.length
      ? `${servers.length} machines`
      : `${filtered.length}/${servers.length} machines`
  const empty = query
    ? selectedFolder
      ? `No hosts in “${selectedFolder.title}” match “${query}”.`
      : `No hosts match “${query}”.`
    : selectedFolder
      ? `No hosts in “${selectedFolder.title}”.`
      : "No hosts configured."

  const changeMode = (values: string[]) => {
    const next = values[0] as "grid" | "list" | undefined
    if (!next) return
    setMode(next)
    localStorage.setItem("lt-ovmode", next)
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5"
      aria-labelledby="overview-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 id="overview-title" className="text-lg font-semibold">Hosts</h1>
          <p className="text-xs text-muted-foreground">{count} · key auth</p>
        </div>
        <div className="ml-3 flex flex-wrap gap-1" role="group" aria-label="Host group">
          <Button
            size="sm"
            variant={group === null ? "default" : "outline"}
            aria-pressed={group === null}
            onClick={() => void onGroupChange(null)}
          >
            All
          </Button>
          {folders.map((folder) => (
            <Button
              key={folder.key}
              size="sm"
              variant={group === folder.key ? "default" : "outline"}
              aria-pressed={group === folder.key}
              onClick={() => void onGroupChange(folder.key)}
            >
              {folder.title}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ToggleGroup
            value={[mode]}
            onValueChange={changeMode}
            variant="outline"
            spacing={0}
            aria-label="Overview layout"
          >
            <ToggleGroupItem value="grid" aria-label="Grid view">
              <Grid2X2 />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
          <Input
            className="w-52"
            aria-label="Search hosts"
            placeholder="Search hosts…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>
      {!filtered.length ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No matching hosts</EmptyTitle>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : mode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {filtered.map((server) => (
            <HostCard
              key={server.id}
              server={server}
              status={statuses[server.id]}
              onOpen={() => onOpen(server.id)}
            />
          ))}
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((server) => (
            <HostRow
              key={server.id}
              server={server}
              status={statuses[server.id]}
              onOpen={() => onOpen(server.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function statusText(server: Server, status?: HostStatus) {
  if (!status) return "connecting…"
  if (!status.online) return `offline${status.error ? ` · ${status.error}` : ""}`
  const gpu = gpuSummary(status)
  const disk = status.disks.reduce<HostStatus["disks"][number] | undefined>(
    (largest, item) => (!largest || item.size > largest.size ? item : largest),
    undefined,
  )
  if (gpu) {
    const availability = gpu.idle > 0 ? `${gpu.idle} idle` : "all busy"
    const diskUsage = disk ? ` · disk ${percent(disk.used, disk.size)}%` : ""
    return `GPU ${gpu.average}% · ${availability}${diskUsage}`
  }
  if (server.kind === "nas") {
    return disk
      ? `volume ${percent(disk.used, disk.size)}% · ${bytes(disk.size - disk.used)} free`
      : "—"
  }
  const load = status.ncpu
    ? `load ${status.load[0]} · ${status.ncpu} cores`
    : "idle"
  const diskUsage = disk ? ` · disk ${percent(disk.used, disk.size)}%` : ""
  return `${load}${diskUsage}`
}

function address(server: Server) {
  if (server.kind === "wsl") return `${server.user || "wsl"} · Ubuntu`
  if (server.kind === "nas") return `${server.host}:${server.port}`
  return `${server.user}@${server.host}:${server.port}`
}

interface HostProps {
  server: Server
  status?: HostStatus
  onOpen: () => void
}

function HostCard({ server, status, onOpen }: HostProps) {
  const gpu = gpuSummary(status)
  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/50"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen()
      }}
    >
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-md border p-2"><ServerIcon className="size-5" /></div>
          <div className="min-w-0">
            <CardTitle>{server.name}</CardTitle>
            <CardDescription className="truncate">{address(server)}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Badge variant="secondary">{server.gpuLabel || server.kind}</Badge>
          {gpu && gpu.idle > 0 ? <Badge>{gpu.idle} GPU FREE</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">{statusText(server, status)}</p>
      </CardContent>
    </Card>
  )
}

function HostRow({ server, status, onOpen }: HostProps) {
  const gpu = gpuSummary(status)
  return (
    <button
      className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50"
      onClick={onOpen}
    >
      <ServerIcon className="size-5" />
      <span className="min-w-32">
        <span className="block font-medium">{server.name}</span>
        <span className="block text-xs text-muted-foreground">{address(server)}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {statusText(server, status)}
      </span>
      <Badge variant={gpu?.idle ? "default" : "secondary"}>
        {gpu?.idle ? `${gpu.idle} FREE` : server.gpuLabel || server.kind}
      </Badge>
      <span className="text-xs">Open →</span>
    </button>
  )
}
