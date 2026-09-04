import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import {
  ArrowRight,
  ArrowUp,
  Braces,
  Clipboard,
  Download,
  File,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Link,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  Upload,
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
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import type {
  UploadBatch,
  UploadBatchResult,
} from "@/features/transfers/use-transfers"
import { api, jsonRequest } from "@/lib/api"
import { age, bytes, joinPath, parentPath, validName } from "@/lib/format"
import type { FileEntry, ListingResponse, Server } from "@/types"

interface ExplorerProps {
  server: Server
  servers: Server[]
  session: ExplorerSessionState
  onSessionChange: Dispatch<SetStateAction<ExplorerSessionState>>
  onOpenTerminal: () => void
  onTransfersOpen: () => void
  onUploadBatch: (batch: UploadBatch) => Promise<UploadBatchResult>
}

type SortKey = "name" | "size" | "mtime"
type PromptState =
  | {
      title: string
      initial?: string
      run: (value: string) => void
    }
  | null

export interface ExplorerSessionState {
  paths: Record<string, string | undefined>
  forward: Record<string, string[]>
  filterHost?: string
  filter: string
  hidden: boolean
  sort: {
    key: SortKey
    ascending: boolean
  }
}

export function createExplorerSessionState(): ExplorerSessionState {
  return {
    paths: {},
    forward: {},
    filter: "",
    hidden: false,
    sort: { key: "name", ascending: true },
  }
}

export function Explorer({
  server,
  servers,
  session,
  onSessionChange,
  onOpenTerminal,
  onTransfersOpen,
  onUploadBatch,
}: ExplorerProps) {
  const [listing, setListing] = useState<ListingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [prompt, setPrompt] = useState<PromptState>(null)
  const [deleteEntry, setDeleteEntry] = useState<FileEntry | null>(null)
  const [sendEntry, setSendEntry] = useState<FileEntry | null>(null)
  const [sendHost, setSendHost] = useState("")
  const [sendPath, setSendPath] = useState("/")
  const request = useRef(0)
  const active = useRef(false)
  const sessionRef = useRef(session)
  const inputRef = useRef<HTMLInputElement>(null)
  const cwd = session.paths[server.id]
  const filter = session.filterHost === server.id ? session.filter : ""
  const { hidden, sort } = session

  sessionRef.current = session

  const load = useCallback(async (path?: string) => {
    const sequence = ++request.current
    setLoading(true)
    try {
      const result = await api<ListingResponse>(
        path == null
          ? `/api/${server.id}/ls`
          : `/api/${server.id}/ls?path=${encodeURIComponent(path)}`,
      )
      if (!active.current || sequence !== request.current) return
      setListing(result)
      onSessionChange((current) => ({
        ...current,
        paths: { ...current.paths, [server.id]: result.path },
      }))
    } catch (error) {
      if (!active.current || sequence !== request.current) return
      setListing({ path: path || "/", entries: [], error: String(error) })
      onSessionChange((current) => ({
        ...current,
        paths: { ...current.paths, [server.id]: path || "/" },
      }))
    } finally {
      if (active.current && sequence === request.current) setLoading(false)
    }
  }, [onSessionChange, server.id])

  useEffect(() => {
    active.current = true
    setListing(null)
    setSelected(null)
    onSessionChange((current) =>
      current.filterHost === server.id
        ? current
        : { ...current, filterHost: server.id, filter: "" },
    )
    void load(cwd)
    return () => {
      active.current = false
      request.current += 1
    }
  }, [load])

  const enter = (path: string, preserveFilter = false) => {
    onSessionChange((current) => ({
      ...current,
      forward: { ...current.forward, [server.id]: [] },
      filterHost: server.id,
      filter: preserveFilter ? current.filter : "",
    }))
    setSelected(null)
    void load(path)
  }
  const mutate = async (op: string, path: string, to?: string) => {
    try {
      await api(`/api/${server.id}/fs`, jsonRequest("POST", { op, path, to }))
      if (!active.current) return
      const title = (
        {
          mkdir: "Folder created",
          touch: "File created",
          rename: "Renamed",
          delete: "Deleted",
        } as Record<string, string>
      )[op]
      toast.add({ title: title || "Done", type: "success", timeout: 2600 })
      setSelected(null)
      await load(cwd)
    } catch (error) {
      toast.add({
        title: "File operation failed",
        description: String(error),
        type: "error",
        timeout: 2600,
      })
    }
  }
  const promptNew = (kind: "file" | "folder") => {
    setPrompt({
      title: `New ${kind} name`,
      run: (name) => {
        const error = validName(name)
        if (error) {
          toast.add({ title: error, type: "error", timeout: 2600 })
          return
        }
        void mutate(kind === "file" ? "touch" : "mkdir", joinPath(cwd, name.trim()))
      },
    })
  }
  const promptRename = (entry: FileEntry) => {
    setPrompt({
      title: `Rename ${entry.isdir ? "folder" : "file"}`,
      initial: entry.name,
      run: (name) => {
        const error = validName(name)
        if (error) {
          toast.add({ title: error, type: "error", timeout: 2600 })
          return
        }
        if (name.trim() !== entry.name) {
          void mutate(
            "rename",
            joinPath(cwd, entry.name),
            joinPath(cwd, name.trim()),
          )
        }
      },
    })
  }
  const copyPath = (entry: FileEntry) => {
    const path = joinPath(cwd, entry.name)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(path).then(
        () => toast.add({ title: `Copied — ${path}`, timeout: 2600 }),
        () => toast.add({ title: path, timeout: 2600 }),
      )
    } else {
      toast.add({ title: path, timeout: 2600 })
    }
  }
  const download = (entry: FileEntry) => {
    const anchor = document.createElement("a")
    const path = encodeURIComponent(joinPath(cwd, entry.name))
    anchor.href = `/api/${server.id}/download?path=${path}`
    anchor.click()
    toast.add({ title: `Downloading ${entry.name}…`, timeout: 2600 })
  }
  const upload = async (files: File[]) => {
    if (server.kind !== "ssh") {
      toast.add({ title: "Upload supported on SSH hosts (for now)", timeout: 2600 })
      return
    }
    if (!files.length) return
    const destinationPath = cwd || "/"
    await onUploadBatch({
      serverId: server.id,
      destinationPath,
      files: [...files],
    })
    if (
      active.current &&
      (sessionRef.current.paths[server.id] || "/") === destinationPath
    ) {
      await load(destinationPath)
    }
  }
  const openSend = (entry: FileEntry) => {
    const first = servers.find((candidate) => candidate.kind === "ssh" || candidate.kind === "nas")
    setSendEntry(entry)
    setSendHost(first?.id ?? "")
    setSendPath(first?.home || "/")
  }
  const submitSend = async () => {
    if (!sendEntry || !sendHost || !sendPath.trim()) {
      toast.add({ title: "Pick a destination folder", type: "error", timeout: 2600 })
      return
    }
    try {
      await api(
        "/api/transfers/copy",
        jsonRequest("POST", {
          src: {
            sid: server.id,
            path: joinPath(cwd, sendEntry.name),
            name: sendEntry.name,
            size: sendEntry.size || 0,
          },
          dst: { sid: sendHost, path: sendPath.trim() },
        }),
      )
      setSendEntry(null)
      onTransfersOpen()
      toast.add({ title: "Transfer queued", type: "success", timeout: 2600 })
    } catch (error) {
      toast.add({
        title: "Send failed",
        description: String(error),
        type: "error",
        timeout: 2600,
      })
    }
  }

  const entries = useMemo(() => {
    let result = [...(listing?.entries ?? [])]
    if (!hidden) {
      result = result.filter(
        (entry) => !entry.name.startsWith(".") && entry.name !== "#recycle",
      )
    }
    if (filter) {
      const query = filter.toLowerCase()
      result = result.filter((entry) => entry.name.toLowerCase().includes(query))
    }
    const direction = sort.ascending ? 1 : -1
    result.sort((a, b) => {
      if (a.isdir !== b.isdir) return a.isdir ? -1 : 1
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      if (av < bv) return -direction
      if (av > bv) return direction
      return 0
    })
    return result
  }, [filter, hidden, listing, sort])
  const changeSort = (key: SortKey) => {
    onSessionChange((current) => ({
      ...current,
      sort:
        current.sort.key === key
          ? { key, ascending: !current.sort.ascending }
          : { key, ascending: true },
    }))
  }
  const currentParent = listing?.parent || parentPath(cwd)
  const destinations = servers.filter(
    (candidate) => candidate.kind === "ssh" || candidate.kind === "nas",
  )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        void upload([...event.dataTransfer.files])
      }}
    >
      <Card size="sm" className="shrink-0">
        <CardContent className="flex flex-row flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Parent folder"
            disabled={!cwd || cwd === "/" || currentParent === cwd}
            onClick={() => {
              const currentPath = cwd || "/"
              onSessionChange((current) => ({
                ...current,
                forward: {
                  ...current.forward,
                  [server.id]: [
                    ...(current.forward[server.id] || []),
                    currentPath,
                  ],
                },
                filter: "",
              }))
              setSelected(null)
              void load(currentParent)
            }}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            disabled={!session.forward[server.id]?.length}
            onClick={() => {
              const stack = session.forward[server.id] || []
              const target = stack.at(-1)
              if (!target) return
              onSessionChange((current) => ({
                ...current,
                forward: {
                  ...current.forward,
                  [server.id]: (current.forward[server.id] || []).slice(0, -1),
                },
                filter: "",
              }))
              setSelected(null)
              void load(target)
            }}
          >
            <ArrowRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            onClick={() => void load(cwd)}
          >
            <RefreshCw />
          </Button>
          {server.kind === "ssh" && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Upload files here"
                onClick={() => inputRef.current?.click()}
              >
                <Upload />
              </Button>
              <input
                ref={inputRef}
                className="hidden"
                type="file"
                multiple
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])]
                  event.currentTarget.value = ""
                  void upload(files)
                }}
              />
            </>
          )}
          <div className="min-w-48 flex-1">
            <ExplorerBreadcrumb server={server} path={cwd || "/"} onGo={enter} />
          </div>
          <Input
            className="w-44"
            aria-label="Filter files"
            placeholder="filter…"
            value={filter}
            onChange={(event) =>
              onSessionChange((current) => ({
                ...current,
                filterHost: server.id,
                filter: event.target.value,
              }))
            }
          />
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={hidden}
              onCheckedChange={(checked) =>
                onSessionChange((current) => ({ ...current, hidden: checked }))
              }
            />
            HIDDEN
          </label>
        </CardContent>
      </Card>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_14rem] gap-4">
        <ContextMenu>
          <ContextMenuTrigger className="min-w-0">
            <Card className="h-full gap-0 py-0">
              <ScrollArea className="h-full">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <button
                          aria-label={`NAME ${sortIndicator(sort, "name")}`}
                          onClick={() => changeSort("name")}
                        >
                          Name {sortIndicator(sort, "name")}
                        </button>
                      </TableHead>
                      <TableHead className="w-24 text-right">
                        <button
                          aria-label={`SIZE ${sortIndicator(sort, "size")}`}
                          onClick={() => changeSort("size")}
                        >
                          Size {sortIndicator(sort, "size")}
                        </button>
                      </TableHead>
                      <TableHead className="w-32 text-right">
                        <button
                          aria-label={`MODIFIED ${sortIndicator(sort, "mtime")}`}
                          onClick={() => changeSort("mtime")}
                        >
                          Modified {sortIndicator(sort, "mtime")}
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableMessage>
                        <Spinner /> Listing {server.name}:{cwd || "home"}…
                      </TableMessage>
                    ) : listing?.error ? (
                      <TableMessage>
                        Couldn’t list this folder. {listing.error}
                      </TableMessage>
                    ) : entries.length ? (
                      entries.map((entry) => (
                        <FileRow
                          key={entry.name}
                          entry={entry}
                          selected={selected?.name === entry.name}
                          onSelect={() =>
                            entry.isdir
                              ? enter(joinPath(cwd, entry.name))
                              : setSelected(entry)
                          }
                          onRename={() => promptRename(entry)}
                          onDelete={() => setDeleteEntry(entry)}
                          onCopy={() => copyPath(entry)}
                          onDownload={() => download(entry)}
                          onSend={() => openSend(entry)}
                          canTransfer={
                            !entry.isdir &&
                            (server.kind === "ssh" || server.kind === "nas")
                          }
                        />
                      ))
                    ) : (
                      <TableMessage>
                        Empty folder{filter ? " (filter active)" : ""}.
                      </TableMessage>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </Card>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {!loading && !listing?.error && (
              <>
                <ContextMenuItem onClick={() => promptNew("file")}>
                  <FilePlus2 /> New file…
                </ContextMenuItem>
                <ContextMenuItem onClick={() => promptNew("folder")}>
                  <FolderPlus /> New folder…
                </ContextMenuItem>
                {server.kind === "ssh" && (
                  <ContextMenuItem onClick={() => inputRef.current?.click()}>
                    <Upload /> Upload files here…
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem onClick={() => void load(cwd)}>
              <RefreshCw /> Refresh
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Card size="sm" className="min-h-0">
          <CardHeader className="border-b">
            <CardTitle>Selection</CardTitle>
            <CardDescription>File details and actions</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 overflow-auto">
            <Preview
              entry={selected}
              server={server}
              cwd={cwd}
              onOpen={() => selected && enter(joinPath(cwd, selected.name), true)}
              onTerminal={onOpenTerminal}
              onCopy={() => selected && copyPath(selected)}
              onDownload={() => selected && download(selected)}
              onSend={() => selected && openSend(selected)}
            />
          </CardContent>
        </Card>
      </div>
      <NamePrompt state={prompt} onClose={() => setPrompt(null)} />
      <AlertDialog
        open={deleteEntry !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteEntry(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteEntry?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone
              {deleteEntry?.isdir
                ? " and everything inside the folder will be removed"
                : ""}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteEntry) void mutate("delete", joinPath(cwd, deleteEntry.name))
                setDeleteEntry(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={sendEntry !== null}
        onOpenChange={(open) => {
          if (!open) setSendEntry(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send “{sendEntry?.name}”</DialogTitle>
            <DialogDescription>
              Copies over the lab network with live progress in Transfers.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Destination host
            <Select
              value={sendHost}
              onValueChange={(value) => {
                const host = servers.find((item) => item.id === value)
                setSendHost(value ?? "")
                setSendPath(host?.home || "/")
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((host) => (
                  <SelectItem key={host.id} value={host.id}>
                    {host.name}
                    {host.kind === "nas" ? " · NAS" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-2 text-sm">
            Destination folder
            <Input
              value={sendPath}
              onChange={(event) => setSendPath(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendEntry(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitSend()}>Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function sortValue(entry: FileEntry, key: SortKey) {
  if (key === "name") return entry.name.toLowerCase()
  if (key === "size") return entry.isdir ? -1 : entry.size
  return entry.mtime
}

function sortIndicator(sort: ExplorerSessionState["sort"], key: SortKey) {
  if (sort.key !== key) return ""
  return sort.ascending ? "↑" : "↓"
}

function ExplorerBreadcrumb({
  server,
  path,
  onGo,
}: {
  server: Server
  path: string
  onGo: (path: string) => void
}) {
  let built = ""
  return (
    <Breadcrumb>
      <BreadcrumbList className="flex-wrap">
        <BreadcrumbItem>
          <BreadcrumbLink
            className="font-medium"
            render={<button type="button" />}
            onClick={() => onGo("/")}
          >
            {server.name}
          </BreadcrumbLink>
        </BreadcrumbItem>
        {path
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => {
            built += `/${part}`
            const target = built
            const current = index === parts.length - 1
            return (
              <Fragment key={target}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {current ? (
                    <BreadcrumbPage className="break-all">{part}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={<button type="button" />}
                      onClick={() => onGo(target)}
                    >
                      {part}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            )
          })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

interface FileRowProps {
  entry: FileEntry
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onCopy: () => void
  onDownload: () => void
  onSend: () => void
  canTransfer: boolean
}

function TableMessage({ children }: { children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={3} className="h-28 text-center text-muted-foreground">
        <span className="inline-flex items-center gap-2">{children}</span>
      </TableCell>
    </TableRow>
  )
}

function FileRow({
  entry,
  selected,
  onSelect,
  onRename,
  onDelete,
  onCopy,
  onDownload,
  onSend,
  canTransfer,
}: FileRowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <TableRow
            data-state={selected ? "selected" : undefined}
            className={entry.name.startsWith(".") ? "opacity-60" : undefined}
          />
        }
      >
        <TableCell className="whitespace-normal">
          <button className="flex min-w-0 items-center gap-2" onClick={onSelect}>
            <FileIcon entry={entry} />
            <span className="break-all text-left">{entry.name}</span>
          </button>
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">
          {entry.isdir ? "—" : bytes(entry.size)}
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">
          {entry.mtime ? age(entry.mtime) : ""}
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entry.isdir && (
          <ContextMenuItem onClick={onSelect}><FolderOpen /> Open</ContextMenuItem>
        )}
        {canTransfer && (
          <>
            <ContextMenuItem onClick={onDownload}><Download /> Download</ContextMenuItem>
            <ContextMenuItem onClick={onSend}><Send /> Send to…</ContextMenuItem>
          </>
        )}
        <ContextMenuItem onClick={onRename}><FileText /> Rename…</ContextMenuItem>
        <ContextMenuItem onClick={onCopy}><Clipboard /> Copy path</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete {entry.isdir ? "folder" : "file"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isdir) {
    return <Folder className="size-4 text-chart-3" />
  }
  if (entry.islink) {
    return <Link className="size-4" />
  }
  const extension = entry.name.toLowerCase().split(".").pop()
  if (
    ["js", "jsx", "ts", "tsx", "py", "rs", "go", "c", "cpp", "java", "sh", "ps1"]
      .includes(extension || "")
  ) {
    return <FileCode2 className="size-4 text-chart-2" />
  }
  if (["json", "yaml", "yml", "toml"].includes(extension || "")) {
    return <FileJson className="size-4 text-chart-4" />
  }
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension || "")) {
    return <Image className="size-4 text-chart-5" />
  }
  if (["md", "txt", "log", "tex"].includes(extension || "")) {
    return <Braces className="size-4" />
  }
  return <File className="size-4" />
}

interface PreviewProps {
  entry: FileEntry | null
  server: Server
  cwd?: string
  onOpen: () => void
  onTerminal: () => void
  onCopy: () => void
  onDownload: () => void
  onSend: () => void
}

function Preview({ entry, server, cwd, onOpen, onTerminal, onCopy, onDownload, onSend }: PreviewProps) {
  if (!entry) {
    return (
      <Empty className="p-0">
        <EmptyHeader>
          <EmptyTitle>Nothing selected</EmptyTitle>
          <EmptyDescription>Click a file to preview. Click a folder to open it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="space-y-3">
      <FileIcon entry={entry} />
      <h2 className="font-medium break-all">{entry.name}</h2>
      <p className="text-xs text-muted-foreground">
        {entry.isdir ? "Folder" : bytes(entry.size)} · {server.name}<br />{cwd}/
      </p>
      {entry.isdir ? (
        <>
          <Button className="w-full" onClick={onOpen}><FolderOpen /> Open</Button>
          <Button className="w-full" variant="outline" onClick={onCopy}>
            <Clipboard /> Copy path
          </Button>
          {server.kind !== "nas" && (
            <Button className="w-full" variant="outline" onClick={onTerminal}>
              <Terminal /> Open terminal here
            </Button>
          )}
        </>
      ) : (
        <>
          <Button className="w-full" onClick={onSend}><Send /> Send to…</Button>
          <Button className="w-full" variant="outline" onClick={onDownload}>
            <Download /> Download
          </Button>
          <Button className="w-full" variant="outline" onClick={onCopy}>
            <Clipboard /> Copy path
          </Button>
        </>
      )}
    </div>
  )
}

interface NamePromptProps {
  state: PromptState
  onClose: () => void
}

function NamePrompt({ state, onClose }: NamePromptProps) {
  const [value, setValue] = useState("")
  useEffect(() => {
    setValue(state?.initial ?? "")
  }, [state])
  const submit = () => {
    const run = state?.run
    onClose()
    if (run && value.trim()) run(value.trim())
  }
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader><DialogTitle>{state?.title}</DialogTitle></DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
