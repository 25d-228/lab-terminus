import { useCallback, useEffect, useRef, useState } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { Terminal } from "@xterm/xterm"
import { Eraser, Plus, Radio, RefreshCw, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/toast"
import type { Theme } from "@/hooks/use-theme"
import type { Server } from "@/types"

const TERMINAL_SCROLLBACK = 8000
const MAX_PASTE_BYTES = 512 * 1024

interface Session {
  key: string
  host: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  ws: WebSocket
  wrap: HTMLDivElement
  connected: boolean
  observer?: ResizeObserver
  disposed: boolean
}

interface TerminalWorkspaceProps {
  server: Server | null
  visible: boolean
  theme: Theme
}

export function TerminalWorkspace({ server, visible, theme }: TerminalWorkspaceProps) {
  const mount = useRef<HTMLDivElement>(null)
  const sessions = useRef(new Map<string, Session>())
  const tabs = useRef<Record<string, string[]>>({})
  const active = useRef<Record<string, string>>({})
  const sequence = useRef(0)
  const [version, setVersion] = useState(0)
  const [broadcast, setBroadcast] = useState(false)
  const broadcastRef = useRef(broadcast)
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState("")

  broadcastRef.current = broadcast

  const themeValues = useCallback(() => {
    const styles = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback
    return {
      background: token("--terminal-background", theme === "dark" ? "#171717" : "#ffffff"),
      foreground: token("--terminal-foreground", theme === "dark" ? "#fafafa" : "#171717"),
      cursor: token("--terminal-cursor", theme === "dark" ? "#fafafa" : "#171717"),
      selectionBackground: token(
        "--terminal-selection",
        theme === "dark" ? "#525252" : "#d4d4d4",
      ),
      black: "#171717",
      red: "#dc2626",
      green: "#16a34a",
      yellow: "#ca8a04",
      blue: "#2563eb",
      magenta: "#9333ea",
      cyan: "#0891b2",
      white: "#e5e5e5",
      brightBlack: "#737373",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#eab308",
      brightBlue: "#3b82f6",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#fafafa",
    }
  }, [theme])

  const dispose = useCallback((session: Session) => {
    if (session.disposed) return
    session.disposed = true
    session.observer?.disconnect()
    session.ws.close()
    session.term.dispose()
    session.wrap.remove()
  }, [])

  const attach = useCallback(
    (key: string) => {
      const session = sessions.current.get(key)
      if (!session || !mount.current) return
      mount.current.replaceChildren(session.wrap)
      active.current[session.host] = key
      try {
        session.fit.fit()
      } catch {
        // A zero-sized hidden mount is fitted when shown.
      }
      if (visible) session.term.focus()
      setVersion((value) => value + 1)
    },
    [visible],
  )

  const create = useCallback(
    (host: Server) => {
      if (!mount.current) return
      const key = `${host.id}#${++sequence.current}`
      const wrap = document.createElement("div")
      wrap.className = "xterm-session"
      mount.current.replaceChildren(wrap)
      const term = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: TERMINAL_SCROLLBACK,
        theme: themeValues(),
        allowProposedApi: true,
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(search)
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = "11"
      term.open(wrap)
      try {
        fit.fit()
      } catch {
        // The resize observer retries after layout.
      }
      term.writeln(`\x1b[90mConnecting to ${host.host || host.name}…\x1b[0m`)
      const protocol = location.protocol === "https:" ? "wss" : "ws"
      const ws = new WebSocket(
        `${protocol}://${location.host}/api/${host.id}/pty?cols=${term.cols}&rows=${term.rows}`,
      )
      ws.binaryType = "arraybuffer"
      const session: Session = {
        key,
        host: host.id,
        term,
        fit,
        search,
        ws,
        wrap,
        connected: false,
        disposed: false,
      }
      sessions.current.set(key, session)
      const hostTabs = (tabs.current[host.id] ||= [])
      hostTabs.push(key)
      active.current[host.id] = key

      ws.onopen = () => {
        session.connected = true
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }))
        setVersion((value) => value + 1)
      }
      ws.onmessage = (event) => {
        term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data))
      }
      ws.onclose = () => {
        session.connected = false
        if (!session.disposed) {
          term.write("\r\n\x1b[90m[session closed — Reconnect to restart]\x1b[0m\r\n")
        }
        setVersion((value) => value + 1)
      }
      ws.onerror = () => {
        session.connected = false
        setVersion((value) => value + 1)
      }
      term.onData((data) => {
        if (broadcastRef.current) {
          const encoded = new TextEncoder().encode(data)
          for (const current of sessions.current.values()) {
            if (current.ws.readyState === WebSocket.OPEN) current.ws.send(encoded)
          }
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data))
        }
      })
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "r", c: cols, r: rows }))
        }
      })
      term.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "f") {
          if (event.type === "keydown") setFindOpen(true)
          return false
        }
        return true
      })
      wrap.addEventListener("dragover", (event) => event.preventDefault())
      wrap.addEventListener("drop", (event) => {
        event.preventDefault()
        const file = event.dataTransfer?.files[0]
        if (!file) return
        if (file.size > MAX_PASTE_BYTES) {
          toast.add({
            title: `Too big to paste (>${MAX_PASTE_BYTES / 1024} KB)`,
            type: "error",
            timeout: 2600,
          })
          return
        }
        file.text().then((text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(text))
          toast.add({ title: `Pasted “${file.name}” into the shell`, timeout: 2600 })
        })
      })
      if (typeof ResizeObserver !== "undefined") {
        session.observer = new ResizeObserver(() => {
          try {
            fit.fit()
          } catch {
            // Ignore transient zero-size layouts.
          }
        })
        session.observer.observe(wrap)
      }
      setVersion((value) => value + 1)
      term.focus()
    },
    [themeValues],
  )

  const close = useCallback(
    (key: string, reopen = true) => {
      const session = sessions.current.get(key)
      if (!session) return
      const closedActiveSession = active.current[session.host] === key
      dispose(session)
      sessions.current.delete(key)
      const remaining = (tabs.current[session.host] || []).filter((item) => item !== key)
      tabs.current[session.host] = remaining
      if (closedActiveSession) active.current[session.host] = remaining.at(-1) || ""
      if (reopen && server?.id === session.host) {
        if (!remaining.length) create(server)
        else if (closedActiveSession) attach(active.current[session.host])
      }
      setVersion((value) => value + 1)
    },
    [attach, create, dispose, server],
  )

  useEffect(() => {
    if (!visible || !server || !mount.current) return
    const key = active.current[server.id]
    if (key && sessions.current.has(key)) attach(key)
    else create(server)
  }, [attach, create, server, visible])

  useEffect(() => {
    for (const session of sessions.current.values()) {
      session.term.options.theme = themeValues()
    }
  }, [themeValues])

  useEffect(
    () => () => {
      for (const session of sessions.current.values()) dispose(session)
      sessions.current.clear()
    },
    [dispose],
  )

  const hostTabs = server ? tabs.current[server.id] || [] : []
  const currentKey = server ? active.current[server.id] : ""
  const current = sessions.current.get(currentKey)
  void version
  const search = (direction: 1 | -1) => {
    if (!find) return
    if (direction > 0) current?.search.findNext(find)
    else current?.search.findPrevious(find)
  }

  return (
    <div
      className={`${visible ? "flex" : "hidden"} min-h-0 flex-1 flex-col bg-[var(--terminal-background)]`}
      aria-hidden={!visible}
    >
      <div className="flex min-h-11 items-center gap-1 border-b bg-background px-2 text-xs">
        <span
          className={`size-2 rounded-full ${current?.connected ? "bg-chart-2" : "bg-muted-foreground"}`}
        />
        <span>{server?.kind === "wsl" ? "wsl.exe" : "ssh"} · {server?.host}</span>
        <span className="text-muted-foreground">
          {current?.connected ? "connected" : "disconnected"}
        </span>
        <div className="ml-2 flex items-center">
          {hostTabs.map((key, index) => (
            <div key={key} className="flex items-center">
              <Button
                variant={key === currentKey ? "secondary" : "ghost"}
                size="sm"
                onClick={() => attach(key)}
              >
                sh{index + 1}
              </Button>
              {hostTabs.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close shell ${index + 1}`}
                  onClick={() => close(key)}
                >
                  <X />
                </Button>
              )}
            </div>
          ))}
          {server && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New shell on this host"
              onClick={() => create(server)}
            >
              <Plus />
            </Button>
          )}
        </div>
        <div className="ml-auto flex gap-1">
          <Button
            variant={broadcast ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setBroadcast(!broadcast)
              toast.add({
                title: !broadcast
                  ? "Broadcast ON — keystrokes go to ALL open sessions"
                  : "Broadcast off",
                timeout: 2600,
              })
            }}
          >
            <Radio /> Broadcast
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setFindOpen((open) => !open)}>
            <Search /> Find
          </Button>
          <Button variant="ghost" size="sm" onClick={() => current?.term.clear()}>
            <Eraser /> Clear
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (currentKey) close(currentKey, false)
              if (server) create(server)
            }}
          >
            <RefreshCw /> Reconnect
          </Button>
        </div>
      </div>
      {findOpen && (
        <div className="flex items-center gap-1 border-b bg-background p-2">
          <Input
            autoFocus
            className="ml-auto w-64"
            aria-label="Search scrollback"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search(event.shiftKey ? -1 : 1)
              if (event.key === "Escape") setFindOpen(false)
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => search(-1)}>Previous</Button>
          <Button variant="ghost" size="sm" onClick={() => search(1)}>Next</Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close search"
            onClick={() => {
              setFindOpen(false)
              current?.term.focus()
            }}
          >
            <X />
          </Button>
        </div>
      )}
      <div ref={mount} className="terminal-mount min-h-0 flex-1 p-2" />
    </div>
  )
}
