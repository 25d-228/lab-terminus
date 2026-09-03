import { useEffect, useState } from "react"

import { toast } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, jsonRequest } from "@/lib/api"
import type { Folder, Server, ServerDraft, ServerKind } from "@/types"

export type RegistryDialogState =
  | { type: "server"; server?: Server; folder?: string }
  | { type: "folder"; folder?: Folder }
  | null

interface RegistryDialogProps {
  state: RegistryDialogState
  folders: Folder[]
  onClose: () => void
  onSaved: () => Promise<unknown>
}

const emptyDraft = (folder: string): ServerDraft => ({
  name: "", kind: "ssh", host: "", port: "", user: "", gpuLabel: "", group: folder,
})

export function RegistryDialog({ state, folders, onClose, onSaved }: RegistryDialogProps) {
  const [draft, setDraft] = useState<ServerDraft>(emptyDraft(folders[0]?.key ?? "lab"))
  const [folderTitle, setFolderTitle] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!state) return
    if (state.type === "folder") setFolderTitle(state.folder?.title ?? "")
    else if (state.server) {
      setDraft({
        name: state.server.name,
        kind: state.server.kind,
        host: state.server.host ?? "",
        port: state.server.port?.toString() ?? "",
        user: state.server.user ?? "",
        gpuLabel: state.server.gpuLabel ?? "",
        group: state.server.group ?? "lab",
      })
    } else setDraft(emptyDraft(state.folder ?? folders[0]?.key ?? "lab"))
  }, [folders, state])

  const save = async () => {
    if (!state || saving) return
    if (state.type === "folder" && !folderTitle.trim()) {
      toast.add({ title: "Folder name required", type: "error", timeout: 2600 })
      return
    }
    if (state.type === "server" && !draft.name.trim()) {
      toast.add({ title: "Name required", type: "error", timeout: 2600 })
      return
    }
    setSaving(true)
    try {
      if (state.type === "folder") {
        const path = state.folder ? `/api/folders/${state.folder.key}` : "/api/folders"
        await api(path, jsonRequest(state.folder ? "PUT" : "POST", { title: folderTitle.trim() }))
        toast.add({ title: state.folder ? "Folder renamed" : `Folder “${folderTitle.trim()}” added`, type: "success", timeout: 2600 })
      } else {
        const path = state.server ? `/api/servers/${state.server.id}` : "/api/servers"
        await api(path, jsonRequest(state.server ? "PUT" : "POST", { ...draft, name: draft.name.trim() }))
        toast.add({ title: state.server ? `Saved “${draft.name.trim()}”` : `Server “${draft.name.trim()}” added`, type: "success", timeout: 2600 })
      }
      await onSaved()
      onClose()
    } catch (error) {
      toast.add({ title: "Save failed", description: String(error), type: "error", timeout: 2600 })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.type === "folder" ? (state.folder ? "Rename folder" : "Add folder") : state?.server ? "Edit server" : "Add server"}</DialogTitle>
          <DialogDescription>Changes are saved to the active Lab Terminus configuration.</DialogDescription>
        </DialogHeader>
        {state?.type === "folder" ? (
          <label className="grid gap-2 text-sm">
            Folder name
            <Input
              autoFocus
              value={folderTitle}
              onChange={(event) => setFolderTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save()
              }}
            />
          </label>
        ) : state?.type === "server" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} autoFocus />
            <label className="grid gap-2 text-sm">
              Kind
              <Select
                value={draft.kind}
                onValueChange={(kind) =>
                  setDraft({ ...draft, kind: kind as ServerKind })
                }
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ssh">SSH server</SelectItem>
                  <SelectItem value="wsl">WSL</SelectItem>
                  <SelectItem value="nas">Synology NAS</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <Field label="Host / IP" value={draft.host} onChange={(host) => setDraft({ ...draft, host })} />
            <Field label="Port" value={draft.port} onChange={(port) => setDraft({ ...draft, port })} />
            <Field label="User" value={draft.user} onChange={(user) => setDraft({ ...draft, user })} />
            <Field label="Label (GPU / role)" value={draft.gpuLabel} onChange={(gpuLabel) => setDraft({ ...draft, gpuLabel })} />
            <label className="col-span-2 grid gap-2 text-sm">
              Folder
              <Select
                value={draft.group}
                onValueChange={(group) => setDraft({ ...draft, group: group ?? "lab" })}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {folders.map((folder) => (
                    <SelectItem key={folder.key} value={folder.key}>
                      {folder.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  return <label className="grid gap-2 text-sm">{label}<Input autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} /></label>
}
