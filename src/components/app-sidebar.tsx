import { useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FolderCog,
  Pencil,
  Plus,
  Server as ServerIcon,
  SquareMenu,
  Terminal,
  Trash2,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { toast } from "@/components/ui/toast"
import type { AppView } from "@/hooks/use-lab-app"
import { api, jsonRequest } from "@/lib/api"
import { gpuSummary } from "@/lib/format"
import type { Folder, HostStatus, Server } from "@/types"
import type { RegistryDialogState } from "./registry-dialog"

interface AppSidebarProps {
  servers: Server[]
  folders: Folder[]
  statuses: Record<string, HostStatus>
  view: AppView
  onViewChange: (view: AppView) => void
  onEdit: (state: RegistryDialogState) => void
  onRefresh: () => Promise<unknown>
}

export function AppSidebar({
  servers,
  folders,
  statuses,
  view,
  onViewChange,
  onEdit,
  onRefresh,
}: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("lt-collapsed") ?? "{}") as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })
  const [remove, setRemove] = useState<{
    type: "server" | "folder"
    id: string
    label: string
  } | null>(null)
  const freeHosts = servers.filter(
    (server) => (gpuSummary(statuses[server.id])?.idle ?? 0) > 0,
  ).length

  const toggle = (key: string) => {
    const next = { ...collapsed, [key]: !(key in collapsed ? collapsed[key] : true) }
    setCollapsed(next)
    localStorage.setItem("lt-collapsed", JSON.stringify(next))
  }

  const confirmRemove = async () => {
    if (!remove) return
    try {
      await api(
        remove.type === "server" ? `/api/servers/${remove.id}` : `/api/folders/${remove.id}`,
        jsonRequest("DELETE"),
      )
      await onRefresh()
      toast.add({
        title: `${remove.type === "server" ? "Server" : "Folder"} removed`,
        type: "success",
        timeout: 2600,
      })
    } catch (error) {
      toast.add({
        title: `Could not remove ${remove.type}`,
        description: String(error),
        type: "error",
        timeout: 2600,
      })
    } finally {
      setRemove(null)
    }
  }

  return (
    <>
      <Sidebar collapsible="none" className="relative h-full w-60">
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === "overview"}
                  onClick={() => onViewChange({ kind: "overview" })}
                >
                  <SquareMenu />
                  <span>Overview</span>
                  <SidebarMenuBadge>
                    {freeHosts ? `${freeHosts} GPU FREE` : ""}
                  </SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Machines</SidebarGroupLabel>
            <SidebarGroupAction
              aria-label="Add server"
              onClick={() => onEdit({ type: "server", folder: folders[0]?.key })}
            >
              <Plus />
            </SidebarGroupAction>
            <SidebarGroupContent className="space-y-1">
              {folders.map((folder) => {
                const items = servers.filter(
                  (server) => (server.group || "lab") === folder.key,
                )
                const isCollapsed =
                  folder.key in collapsed ? collapsed[folder.key] : true
                return (
                  <div key={folder.key}>
                    <ContextMenu>
                      <ContextMenuTrigger className="block">
                        <button
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent"
                          onClick={() => toggle(folder.key)}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="size-3" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )}
                          <span className="truncate">{folder.title}</span>
                          <span className="ml-auto">{items.length}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => onEdit({ type: "folder", folder })}>
                          <Pencil />
                          Rename folder…
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => onEdit({ type: "server", folder: folder.key })}
                        >
                          <Plus />
                          Add server here…
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onClick={() =>
                            setRemove({
                              type: "folder",
                              id: folder.key,
                              label: folder.title,
                            })
                          }
                        >
                          <Trash2 />
                          Remove folder
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {!isCollapsed && (
                      <SidebarMenu className="pl-2">
                        {items.length ? (
                          items.map((server) => (
                            <ServerRow
                              key={server.id}
                              server={server}
                              status={statuses[server.id]}
                              active={view.kind === "server" && view.id === server.id}
                              onOpen={(tab) =>
                                onViewChange({ kind: "server", id: server.id, tab })
                              }
                              defaultTab={view.kind === "server" ? view.tab : "explorer"}
                              onEdit={() => onEdit({ type: "server", server })}
                              onRemove={() =>
                                setRemove({
                                  type: "server",
                                  id: server.id,
                                  label: server.name,
                                })
                              }
                            />
                          ))
                        ) : (
                          <li className="px-2 py-1 text-xs text-muted-foreground">empty</li>
                        )}
                      </SidebarMenu>
                    )}
                  </div>
                )
              })}
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent"
                onClick={() => onEdit({ type: "folder" })}
              >
                <FolderCog className="size-4" />
                Add folder…
              </button>
              {!folders.length && (
                <div className="p-2 text-xs text-muted-foreground">
                  No folders configured.
                </div>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <AlertDialog
        open={remove !== null}
        onOpenChange={(open) => {
          if (!open) setRemove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {remove?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This updates the active configuration. Hosts in a removed folder are reassigned to
              the first remaining folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmRemove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface ServerRowProps {
  server: Server
  status?: HostStatus
  active: boolean
  onOpen: (tab: "explorer" | "terminal" | "monitor") => void
  defaultTab: "explorer" | "terminal" | "monitor"
  onEdit: () => void
  onRemove: () => void
}

function ServerRow({
  server,
  status,
  active,
  onOpen,
  defaultTab,
  onEdit,
  onRemove,
}: ServerRowProps) {
  const summary = gpuSummary(status)
  const openTab =
    server.kind === "nas" && defaultTab === "terminal" ? "explorer" : defaultTab
  const subtitle =
    server.kind === "wsl"
      ? "Ubuntu · WSL"
      : server.kind === "nas"
        ? "Synology DSM"
        : server.gpuLabel || server.host || "server"

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger className="block">
          <SidebarMenuButton
            isActive={active}
            size="lg"
            onClick={() => onOpen(openTab)}
          >
            <ServerIcon />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{server.name}</span>
              <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
            </span>
            {summary ? (
              <span className="ml-auto text-xs">
                {summary.idle === summary.total ? "FREE" : `${summary.average}%`}
              </span>
            ) : null}
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onEdit}>
            <Pencil />
            Edit server…
          </ContextMenuItem>
          {server.kind !== "nas" && (
            <ContextMenuItem onClick={() => onOpen("terminal")}>
              <Terminal />
              Open terminal
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={onRemove}>
            <Trash2 />
            Remove server
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )
}
