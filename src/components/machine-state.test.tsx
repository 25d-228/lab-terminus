import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MachineStateBadge } from "./machine-state"

describe("MachineStateBadge", () => {
  it("shows text-only machine states with color applied only to the text", () => {
    render(
      <>
        <MachineStateBadge status={{ online: true }} />
        <MachineStateBadge status={{ online: false }} />
        <MachineStateBadge />
      </>,
    )

    const online = screen.getByLabelText("Machine status: online")
    const offline = screen.getByLabelText("Machine status: offline")
    const connecting = screen.getByLabelText("Machine status: connecting")

    expect(online).toHaveTextContent("online")
    expect(online).toHaveClass("text-green-700", "dark:text-green-400")
    expect(offline).toHaveTextContent("offline")
    expect(offline).toHaveClass("text-red-700", "dark:text-red-400")
    expect(connecting).toHaveTextContent("connecting")
    expect(connecting).toHaveClass("text-muted-foreground")
    expect(document.querySelector("svg")).not.toBeInTheDocument()
    expect(online.className).not.toMatch(/bg-green|border-green/)
    expect(offline.className).not.toMatch(/bg-red|border-red/)
  })
})
