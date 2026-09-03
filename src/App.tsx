import { useCallback, useMemo, useState } from "react"
import { ChartLine, FolderOpen, HardDrive, Terminal as TerminalIcon } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { RegistryDialog, type RegistryDialogState } from "@/components/registry-dialog"
import { TitleBar } from "@/components/title-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  createExplorerSessionState,
  Explorer,
  type ExplorerSessionState,
} from "@/features/explorer/explorer"
import { Monitor } from "@/features/monitor/monitor"
import { Overview } from "@/features/overview/overview"
import { TerminalWorkspace } from "@/features/terminal/terminal-workspace"
import { TransferDrawer } from "@/features/transfers/transfer-drawer"
import { useTransfers } from "@/features/transfers/use-transfers"
import { useLabApp } from "@/hooks/use-lab-app"
import { useTheme } from "@/hooks/use-theme"
import { gpuSummary, percent } from "@/lib/format"
import type { HostStatus, Server } from "@/types"

export function App() {
  const lab = useLabApp()
  const { theme, setTheme } = useTheme()
  const transfers = useTransfers(!lab.loading && !lab.startupError)
  const [registryDialog, setRegistryDialog] = useState<RegistryDialogState>(null)
  const [overviewQuery, setOverviewQuery] = useState("")
  const [explorerSession, setExplorerSession] = useState<ExplorerSessionState>(
    createExplorerSessionState,
  )
  const activeServerId = lab.view.kind === "server" ? lab.view.id : null
  const server = useMemo(
    () =>
      activeServerId
        ? lab.servers.find((item) => item.id === activeServerId) || null
        : null,
    [activeServerId, lab.servers],
  )
  const tab = lab.view.kind === "server" ? lab.view.tab : null
  const changeTab = (next: string) => {
    if (server && ["explorer", "terminal", "monitor"].includes(next)) {
      lab.setView({
        kind: "server",
        id: server.id,
        tab: next as "explorer" | "terminal" | "monitor",
      })
    }
  }
  const handleMonitorStatus = useCallback((status: HostStatus) => {
    lab.setStatuses((current) => ({ ...current, [status.id]: status }))
  }, [lab.setStatuses])

  return (
    <TooltipProvider>
      <Toaster>
        <div className="app-frame flex h-screen min-h-[600px] w-screen min-w-[900px] flex-col overflow-hidden bg-background text-foreground">
          <TitleBar theme={theme} onThemeChange={setTheme} />
          {lab.loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Connecting to Lab Terminus…
            </div>
          ) : lab.startupError ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>Backend not reachable</EmptyTitle>
                <EmptyDescription>
                  Is the server running?
                  <br />
                  {lab.startupError}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SidebarProvider className="min-h-0 flex-1" open onOpenChange={() => undefined}>
              <AppSidebar
                servers={lab.servers}
                folders={lab.folders}
                statuses={lab.statuses}
                view={lab.view}
                onViewChange={lab.setView}
                onEdit={setRegistryDialog}
                onRefresh={lab.refreshRegistry}
              />
              <main className="flex min-w-0 flex-1 flex-col">
                {server && (
                  <HostHeader
                    server={server}
                    status={lab.statuses[server.id]}
                    tab={tab!}
                    onTab={changeTab}
                  />
                )}
                {lab.view.kind === "overview" ? (
                  <Overview
                    servers={lab.servers}
                    folders={lab.folders}
                    statuses={lab.statuses}
                    group={lab.overviewGroup}
                    query={overviewQuery}
                    onQueryChange={setOverviewQuery}
                    onGroupChange={lab.selectOverviewGroup}
                    onOpen={(id) => lab.setView({ kind: "server", id, tab: "explorer" })}
                  />
                ) : server ? (
                  tab === "explorer" ? (
                    <Explorer
                      key={server.id}
                      server={server}
                      servers={lab.servers}
                      session={explorerSession}
                      onSessionChange={setExplorerSession}
                      onOpenTerminal={() => changeTab("terminal")}
                      onTransfersOpen={() => transfers.setOpen(true)}
                    />
                  ) : null
                ) : (
                  <Empty className="flex-1">
                    <EmptyHeader>
                      <EmptyTitle>Host not found</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
                <TerminalWorkspace
                  server={server?.kind === "nas" ? null : server}
                  visible={tab === "terminal"}
                  theme={theme}
                />
                <Monitor
                  server={server}
                  fleetStatus={server ? lab.statuses[server.id] : undefined}
                  visible={tab === "monitor"}
                  onStatus={handleMonitorStatus}
                />
              </main>
            </SidebarProvider>
          )}
          <footer className="flex h-8 shrink-0 items-center border-t bg-background px-3 text-xs text-muted-foreground">
            <span className="mr-2 size-2 rounded-full bg-chart-2" />
            {lab.connection}
            <span className="mx-auto">live · SSH · SFTP · WSL · DSM</span>
            <Button variant="ghost" size="sm" onClick={() => transfers.setOpen(true)}>
              Transfers
              {transfers.activeCount ? (
                <Badge className="ml-1">{transfers.activeCount}</Badge>
              ) : null}
            </Button>
          </footer>
          <RegistryDialog
            state={registryDialog}
            folders={lab.folders}
            onClose={() => setRegistryDialog(null)}
            onSaved={lab.refreshRegistry}
          />
          <TransferDrawer
            open={transfers.open}
            onOpenChange={transfers.setOpen}
            jobs={transfers.jobs}
            onRefresh={transfers.refresh}
          />
        </div>
      </Toaster>
    </TooltipProvider>
  )
}

interface HostHeaderProps {
  server: Server
  status?: HostStatus
  tab: "explorer" | "terminal" | "monitor"
  onTab: (tab: string) => void
}

function HostHeader({ server, status, tab, onTab }: HostHeaderProps) {
  const gpu = gpuSummary(status)
  const disk = status?.disks.reduce<HostStatus["disks"][number] | undefined>(
    (largest, item) => (!largest || item.size > largest.size ? item : largest),
    undefined,
  )
  const address =
    server.kind === "nas"
      ? `${server.host}:${server.port}`
      : server.kind === "wsl"
        ? "wsl · Ubuntu"
        : `${server.user}@${server.host}:${server.port}`

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span
          className={`size-2 rounded-full ${
            status?.online === false ? "bg-destructive" : "bg-chart-2"
          }`}
        />
        <strong>{server.name}</strong>
        <span className="text-xs text-muted-foreground">
          {address}
          {status?.up ? ` · up ${status.up}` : ""}
        </span>
        <div className="ml-auto flex gap-1">
          {status?.online === false ? (
            <Badge variant="destructive">offline</Badge>
          ) : gpu ? (
            <Badge variant="secondary">
              {gpu.total > 1 ? `${gpu.total}× GPU` : "GPU"} ·{" "}
              {status?.gpus.map((item) => `${item.util}%`).join(" / ")}
            </Badge>
          ) : status?.ncpu ? (
            <Badge variant="secondary">
              {status.ncpu} cores · load {status.load[0]}
            </Badge>
          ) : null}
          {disk && (
            <Badge variant="outline">
              {server.kind === "nas" ? "volume" : "disk"} {percent(disk.used, disk.size)}%
            </Badge>
          )}
          {status?.online !== false && <Badge>live</Badge>}
        </div>
      </div>
      <Tabs value={tab} onValueChange={onTab} className="shrink-0 gap-0">
        <TabsList
          variant="line"
          className="h-10 w-full justify-start rounded-none border-b px-3"
        >
          <TabsTrigger value="explorer">
            <FolderOpen />
            Explorer
          </TabsTrigger>
          {server.kind !== "nas" && (
            <TabsTrigger value="terminal">
              <TerminalIcon />
              Terminal
            </TabsTrigger>
          )}
          <TabsTrigger value="monitor">
            {server.kind === "nas" ? <HardDrive /> : <ChartLine />}
            {server.kind === "nas" ? "Storage" : "Monitor"}
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </>
  )
}
