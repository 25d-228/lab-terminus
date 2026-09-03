import type { Folder, HostStatus, Server } from "@/types"

export const folders: Folder[] = [
  { key: "lab", title: "Lab Servers" },
  { key: "this", title: "This Machine" },
]

export const servers: Server[] = [
  {
    id: "gpu1",
    name: "Exp19",
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    user: "alice",
    gpuLabel: "RTX 4090",
    group: "lab",
  },
  { id: "local", name: "Ubuntu", kind: "wsl", user: "alice", group: "this" },
]

export function status(id = "gpu1", overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    id,
    online: true,
    error: null,
    host: "10.0.0.1",
    up: "1 day",
    load: [1, 0.5, 0.25],
    ncpu: 8,
    mem: { total: 16 * 1024 ** 3, used: 4 * 1024 ** 3 },
    disks: [{ m: "/", size: 100 * 1024 ** 3, used: 25 * 1024 ** 3 }],
    gpus: [
      {
        index: 0,
        name: "RTX 4090",
        mu: 1024,
        mt: 24576,
        util: 5,
        temp: 42,
        pow: 30,
        plim: 450,
      },
    ],
    procs: [],
    network: {
      available: true,
      rx_bytes: 1000,
      tx_bytes: 2000,
      uptime_seconds: 10,
    },
    top_procs: [],
    ...overrides,
  }
}

export function json(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(value), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  })
}
