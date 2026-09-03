import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
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
}

type SortKey = "name" | "size" | "mtime"
type PromptState = { title: string; initial?: string; run: (value: string) => void } | null

export interface ExplorerSessionState {
  paths: Record<string, string | undefined>
  forward: Record<string, string[]>
  filter: string
  hidden: boolean
  sort: { key: SortKey; ascending: boolean }
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
  const inputRef = useRef<HTMLInputElement>(null)
  const cwd = session.paths[server.id]
  const { filter, hidden, sort } = session

  const load = useCallback(async (path?: string) => {
    const sequence = ++request.current
    setLoading(true)
    try {
      const result = await api<ListingResponse>(path == null ? `/api/${server.id}/ls` : `/api/${server.id}/ls?path=${encodeURIComponent(path)}`)
      if (sequence !== request.current) return
      setListing(result)
      onSessionChange((current) => ({
        ...current,
        paths: { ...current.paths, [server.id]: result.path },
      }))
    } catch (error) {
      if (sequence !== request.current) return
      setListing({ path: path || "/", entries: [], error: String(error) })
      onSessionChange((current) => ({
        ...current,
        paths: { ...current.paths, [server.id]: path || "/" },
      }))
    } finally {
      if (sequence === request.current) setLoading(false)
    }
  }, [onSessionChange, server.id])

  useEffect(() => {
    setListing(null)
    setSelected(null)
    void load(cwd)
    return () => { request.current += 1 }
  }, [load])

  const enter = (path: string, preserveFilter = false) => {
    onSessionChange((current) => ({
      ...current,
      forward: { ...current.forward, [server.id]: [] },
      filter: preserveFilter ? current.filter : "",
    }))
    setSelected(null)
    void load(path)
  }
  const mutate = async (op: string, path: string, to?: string) => {
    try {
      await api(`/api/${server.id}/fs`, jsonRequest("POST", { op, path, to }))
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
    anchor.href = `/api/${server.id}/download?path=${encodeURIComponent(joinPath(cwd, entry.name))}`
    anchor.click()
    toast.add({ title: `Downloading ${entry.name}…`, timeout: 2600 })
  }
  const upload = async (files: File[]) => {
    if (server.kind !== "ssh") return toast.add({ title: "Upload supported on SSH hosts (for now)", timeout: 2600 })
    if (!files.length) return
    onTransfersOpen()
    let failed = 0
    for (const file of files) {
      try {
        const response = await fetch(
          `/api/${server.id}/upload?path=${encodeURIComponent(cwd || "/")}&name=${encodeURIComponent(file.name)}`,
          { method: "POST", body: file },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        failed += 1
        toast.add({
          title: `Upload failed: ${file.name}`,
          description: String(error),
          type: "error",
          timeout: 2600,
        })
      }
    }
    if (!failed) toast.add({ title: "Upload complete", type: "success", timeout: 2600 })
    else if (failed < files.length) toast.add({ title: `${files.length - failed} of ${files.length} uploads completed`, type: "warning", timeout: 2600 })
    await load(cwd)
  }
  const openSend = (entry: FileEntry) => {
    const first = servers.find((candidate) => candidate.kind === "ssh" || candidate.kind === "nas")
    setSendEntry(entry); setSendHost(first?.id ?? ""); setSendPath(first?.home || "/")
  }
  const submitSend = async () => {
    if (!sendEntry || !sendHost || !sendPath.trim()) return toast.add({ title: "Pick a destination folder", type: "error", timeout: 2600 })
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
    if (!hidden) result = result.filter((entry) => !entry.name.startsWith(".") && entry.name !== "#recycle")
    if (filter) result = result.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))
    const direction = sort.ascending ? 1 : -1
    result.sort((a, b) => {
      if (a.isdir !== b.isdir) return a.isdir ? -1 : 1
      const av = sort.key === "name" ? a.name.toLowerCase() : sort.key === "size" ? (a.isdir ? -1 : a.size) : a.mtime
      const bv = sort.key === "name" ? b.name.toLowerCase() : sort.key === "size" ? (b.isdir ? -1 : b.size) : b.mtime
      return av < bv ? -direction : av > bv ? direction : 0
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
  const destinations = servers.filter((candidate) => candidate.kind === "ssh" || candidate.kind === "nas")

  return <div
    className="flex min-h-0 flex-1 flex-col"
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      void upload([...event.dataTransfer.files])
    }}
  >
    <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
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
              [server.id]: [...(current.forward[server.id] || []), currentPath],
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
            onChange={(event) => void upload([...(event.target.files ?? [])])}
          />
        </>
      )}
      <Breadcrumbs server={server} path={cwd || "/"} onGo={enter} />
      <Input
        className="ml-auto w-40"
        aria-label="Filter files"
        placeholder="filter…"
        value={filter}
        onChange={(event) =>
          onSessionChange((current) => ({ ...current, filter: event.target.value }))
        }
      />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(event) =>
            onSessionChange((current) => ({ ...current, hidden: event.target.checked }))
          }
        />
        HIDDEN
      </label>
    </div>
    <div className="flex min-h-0 flex-1">
      <ContextMenu>
        <ContextMenuTrigger className="min-w-0 flex-1">
          <ScrollArea className="h-full">
            <div className="grid grid-cols-[minmax(220px,1fr)_100px_130px] border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              <button className="text-left" onClick={() => changeSort("name")}>
                NAME {sort.key === "name" ? sort.ascending ? "↑" : "↓" : ""}
              </button>
              <button className="text-right" onClick={() => changeSort("size")}>
                SIZE {sort.key === "size" ? sort.ascending ? "↑" : "↓" : ""}
              </button>
              <button className="text-right" onClick={() => changeSort("mtime")}>
                MODIFIED {sort.key === "mtime" ? sort.ascending ? "↑" : "↓" : ""}
              </button>
            </div>
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <Spinner /> Listing {server.name}:{cwd || "home"}…
              </div>
            ) : listing?.error ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Couldn’t list this folder.</EmptyTitle>
                  <EmptyDescription>{listing.error}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : entries.length ? (
              entries.map((entry) => (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  selected={selected?.name === entry.name}
                  onSelect={() =>
                    entry.isdir ? enter(joinPath(cwd, entry.name)) : setSelected(entry)
                  }
                  onRename={() => promptRename(entry)}
                  onDelete={() => setDeleteEntry(entry)}
                  onCopy={() => copyPath(entry)}
                  onDownload={() => download(entry)}
                  onSend={() => openSend(entry)}
                  canTransfer={
                    !entry.isdir && (server.kind === "ssh" || server.kind === "nas")
                  }
                />
              ))
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Empty folder{filter ? " (filter active)" : ""}.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </ScrollArea>
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
      <aside className="w-64 shrink-0 border-l p-4">
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
      </aside>
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
            {deleteEntry?.isdir ? " and everything inside the folder will be removed" : ""}.
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
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {destinations.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.name}{host.kind === "nas" ? " · NAS" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-2 text-sm">
          Destination folder
          <Input value={sendPath} onChange={(event) => setSendPath(event.target.value)} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSendEntry(null)}>Cancel</Button>
          <Button onClick={() => void submitSend()}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

function Breadcrumbs({
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
    <div className="flex min-w-0 items-center overflow-hidden rounded-md border px-2 text-xs">
      <button className="font-medium" onClick={() => onGo("/")}>{server.name}</button>
      {path.split("/").filter(Boolean).map((part) => {
        built += `/${part}`
        const target = built
        return (
          <span key={target} className="flex">
            <span className="px-1 text-muted-foreground">/</span>
            <button className="max-w-28 truncate" onClick={() => onGo(target)}>
              {part}
            </button>
          </span>
        )
      })}
    </div>
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
  const rowClass = [
    "grid w-full grid-cols-[minmax(220px,1fr)_100px_130px] items-center",
    "px-3 py-2 text-left text-sm hover:bg-muted/50",
    selected ? "bg-muted" : "",
    entry.name.startsWith(".") ? "opacity-60" : "",
  ].join(" ")
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <button
          className={rowClass}
          onClick={onSelect}
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon entry={entry} />
            <span className="truncate">{entry.name}</span>
          </span>
          <span className="text-right text-xs text-muted-foreground">
            {entry.isdir ? "—" : bytes(entry.size)}
          </span>
          <span className="text-right text-xs text-muted-foreground">
            {entry.mtime ? age(entry.mtime) : ""}
          </span>
        </button>
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
  if (entry.isdir) return <Folder className="size-4 text-chart-3" />
  if (entry.islink) return <Link className="size-4" />
  const extension = entry.name.toLowerCase().split(".").pop()
  if (
    ["js", "jsx", "ts", "tsx", "py", "rs", "go", "c", "cpp", "java", "sh", "ps1"]
      .includes(extension || "")
  ) return <FileCode2 className="size-4 text-chart-2" />
  if (["json", "yaml", "yml", "toml"].includes(extension || "")) return <FileJson className="size-4 text-chart-4" />
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension || "")) return <Image className="size-4 text-chart-5" />
  if (["md", "txt", "log", "tex"].includes(extension || "")) return <Braces className="size-4" />
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

function NamePrompt({ state, onClose }: { state: PromptState; onClose: () => void }) {
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
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{state?.title}</DialogTitle></DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submit() }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
