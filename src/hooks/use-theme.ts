import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark"

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() =>
    localStorage.getItem("lt-mode") === "night" ? "dark" : "light",
  )

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem("lt-mode", next === "dark" ? "night" : "day")
    setThemeState(next)
  }, [])

  return { theme, setTheme }
}
