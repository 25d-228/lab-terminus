import { getCurrentWindow } from "@tauri-apps/api/window"
import { Minus, Moon, Square, Sun, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { Theme } from "@/hooks/use-theme"

interface TitleBarProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

export function TitleBar({ theme, onThemeChange }: TitleBarProps) {
  const window = getCurrentWindow()
  const beginDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest("button,a,input,select,[role=button]")) {
      void window.startDragging()
    }
  }

  return (
    <header
      className="title-bar flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 select-none"
      data-tauri-drag-region
      onMouseDown={beginDrag}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement
        if (!target.closest("button,a,input,select,[role=button]")) {
          void window.toggleMaximize()
        }
      }}
    >
      <div
        className="brand flex items-center gap-2 text-sm font-semibold"
        data-tauri-drag-region
      >
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs text-primary-foreground">
          LT
        </span>
        <span>Lab Terminus</span>
      </div>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Badge variant="outline" data-tauri-drag-region>
        yue_ziran · NLP Lab
      </Badge>
      <div
        className="flex-1 self-stretch"
        data-tauri-drag-region
        onMouseDown={beginDrag}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-label={theme === "light" ? "Switch to Night mode" : "Switch to Day mode"}
        onClick={() => onThemeChange(theme === "light" ? "dark" : "light")}
      >
        {theme === "light" ? <Moon /> : <Sun />}
        {theme === "light" ? "Night" : "Day"}
      </Button>
      <div className="window-controls flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Minimize"
          onClick={() => void window.minimize()}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Maximize or restore"
          onClick={() => void window.toggleMaximize()}
        >
          <Square />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={() => void window.close()}
        >
          <X />
        </Button>
      </div>
    </header>
  )
}
