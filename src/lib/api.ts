export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 140)
    } catch {
      // The status still provides useful context when the response body is unreadable.
    }
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ""}`)
  }
  return response.json() as Promise<T>
}

export function jsonRequest(method: "POST" | "PUT" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}
