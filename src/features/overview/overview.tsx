import { useMemo, useState } from "react"
import { ArrowUpRight, Grid2X2, List, Search, Server as ServerIcon } from "lucide-react"

import { MachineStateBadge } from "@/components/machine-state"
import { GpuUtilization } from "@/components/gpu-utilization"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4"
      aria-labelledby="overview-title"
    >
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle>
            <h1 id="overview-title">Hosts</h1>
          </CardTitle>
          <CardDescription>{count} · key authentication</CardDescription>
          <CardAction>
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
          </CardAction>
        </CardHeader>
        <CardContent className="gap-3">
          <div className="relative max-w-md">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4
                -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="pl-9"
              aria-label="Search hosts"
              placeholder="Search name, address, or role…"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Host group">
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
        </CardContent>
      </Card>
      {!filtered.length ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No matching hosts</EmptyTitle>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : mode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
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
        <Card size="sm">
          <CardContent className="px-0">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Host</TableHead>
                  <TableHead className="w-[32%]">Address</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24 text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((server) => (
                  <HostRow
                    key={server.id}
                    server={server}
                    status={statuses[server.id]}
                    onOpen={() => onOpen(server.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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
    return (
      <>
        GPU <GpuUtilization value={gpu.average} /> · {availability}
        {diskUsage}
      </>
    )
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
  const hostAddress = address(server)
  return (
    <Card
      size="sm"
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen()
      }}
    >
      <CardHeader className="border-b">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ServerIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="break-words">{server.name}</CardTitle>
            <CardDescription>{server.gpuLabel || server.kind}</CardDescription>
          </div>
        </div>
        <CardAction>
          <MachineStateBadge status={status} hideOnline={Boolean(gpu)} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Address</p>
          <p className="break-all font-mono text-xs" data-full-address={hostAddress}>
            {hostAddress}
          </p>
        </div>
        <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          {statusText(server, status)}
        </p>
        {gpu && gpu.idle > 0 ? <Badge>{gpu.idle} GPU FREE</Badge> : null}
      </CardContent>
      <CardFooter className="border-t">
        <span className="text-xs font-medium">Open host</span>
        <ArrowUpRight className="ml-auto size-4" />
      </CardFooter>
    </Card>
  )
}

function HostRow({ server, status, onOpen }: HostProps) {
  const gpu = gpuSummary(status)
  const hostAddress = address(server)
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <Button variant="ghost" className="h-auto min-w-0 justify-start px-0" onClick={onOpen}>
          <ServerIcon className="size-4 shrink-0" />
          <span className="min-w-0 text-left">
            <span className="block break-words font-medium">{server.name}</span>
            <span className="block break-words text-xs text-muted-foreground">
              {server.gpuLabel || server.kind}
            </span>
          </span>
        </Button>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="block break-all font-mono text-xs" data-full-address={hostAddress}>
          {hostAddress}
        </span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="text-xs text-muted-foreground">
          {statusText(server, status)}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-wrap justify-end gap-1">
          {gpu?.idle ? <Badge>{gpu.idle} FREE</Badge> : null}
          <MachineStateBadge status={status} hideOnline={Boolean(gpu)} />
        </div>
      </TableCell>
    </TableRow>
  )
}
