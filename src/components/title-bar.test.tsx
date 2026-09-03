import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const windowCalls = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
}))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowCalls }))

import { useTheme } from "@/hooks/use-theme"
import { TitleBar } from "./title-bar"

function Harness() {
  const theme = useTheme()
  return <TitleBar theme={theme.theme} onThemeChange={theme.setTheme} />
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  vi.clearAllMocks()
})

describe("TitleBar", () => {
  it("defaults to light, switches theme, and calls imported native window controls", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(document.documentElement).not.toHaveClass("dark")
    await user.click(screen.getByRole("button", { name: "Switch to Night mode" }))
    expect(document.documentElement).toHaveClass("dark")
    expect(localStorage.getItem("lt-mode")).toBe("night")
    await user.click(screen.getByRole("button", { name: "Minimize" }))
    await user.click(screen.getByRole("button", { name: "Maximize or restore" }))
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(windowCalls.minimize).toHaveBeenCalledOnce()
    expect(windowCalls.toggleMaximize).toHaveBeenCalledOnce()
    expect(windowCalls.close).toHaveBeenCalledOnce()
  })
})
