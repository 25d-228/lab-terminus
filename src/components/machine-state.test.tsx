import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MachineStateBadge } from "./machine-state"

afterEach(cleanup)

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

  it("keeps a hidden online state accessible without hiding other states", () => {
    render(
      <>
        <MachineStateBadge status={{ online: true }} hideOnline />
        <MachineStateBadge status={{ online: false }} hideOnline />
        <MachineStateBadge hideOnline />
      </>,
    )

    expect(screen.getByLabelText("Machine status: online")).toHaveClass("sr-only")
    expect(screen.getByLabelText("Machine status: online")).not.toHaveAttribute(
      "data-slot",
      "badge",
    )
    expect(screen.getByLabelText("Machine status: offline")).not.toHaveClass("sr-only")
    expect(screen.getByLabelText("Machine status: connecting")).not.toHaveClass("sr-only")
  })
})
