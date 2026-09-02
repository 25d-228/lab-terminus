(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // Tuning constants (timings in ms).
  const TOAST_MS = 2600;
  const TRANSFER_POLL_MS = 1500;
  const MONITOR_POLL_MS = 2000;
  const FLEET_POLL_MS = 5000;
  const TERMINAL_SCROLLBACK = 8000;
  const MAX_PASTE_BYTES = 512 * 1024;
  const GPU_HISTORY_SAMPLES = 48;
  const NETWORK_HISTORY_SAMPLES = 48;
  const PROCESS_SCOPE_LABELS = { mine: "Mine", others: "Others", root: "Root" };
  const MONITOR_SECTION_ORDER = [
    "gpus",
    "network",
    "gpu-processes",
    "top-processes",
    "host",
    "utilization",
    "vram",
  ];
  const MONITOR_SECTION_LABELS = {
    gpus: "GPUs",
    network: "Network",
    "gpu-processes": "GPU processes",
    "top-processes": "Top processes",
    host: "Host",
    utilization: "Utilization",
    vram: "VRAM",
  };
  function esc(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function ph(name, extraClass) {
    return `<i class="ph ph-${name}${extraClass ? " " + extraClass : ""}" aria-hidden="true"></i>`;
  }
  function bytes(n) {
    if (n == null || n < 0 || isNaN(n)) return "";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = 0,
      value = n;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return (value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[i];
  }
  function pct(u, s) {
    return s > 0 ? Math.round((u / s) * 100) : 0;
  }
  function ago(ep) {
    if (!ep) return "";
    let s = Math.floor(Date.now() / 1000 - ep);
    if (s < 0) return "";
    if (s < 60) return "just now";
    const m = (s / 60) | 0;
    if (m < 60) return m + " min ago";
    const h = (m / 60) | 0;
    if (h < 24) return h + " h ago";
    const d = (h / 24) | 0;
    if (d < 30) return d + " d ago";
    const mo = (d / 30) | 0;
    if (mo < 12) return mo + " mo ago";
    return ((mo / 12) | 0) + " y ago";
  }
  const clampPct = (x) => Math.max(0, Math.min(100, x));
  function utilizationTone(value) {
    const percent = clampPct(Math.round(value));
    if (percent < 50) return "online";
    if (percent < 70) return "busy";
    if (percent < 85) return "warning";
    return "destructive";
  }
  function chartTone(index) {
    return "lt-chart-tone-" + ((Math.abs(Number(index) || 0) % 5) + 1);
  }
  function parentOf(p) {
    if (!p || p === "/") return "/";
    const trimmed = p.replace(/\/+$/, "");
    const slashIdx = trimmed.lastIndexOf("/");
    return slashIdx > 0 ? trimmed.slice(0, slashIdx) : "/";
  }
  async function api(p, opts) {
    const resp = await fetch(p, opts);
    if (!resp.ok) {
      let errText = "";
      try {
        errText = (await resp.text()).slice(0, 140);
      } catch (e) {}
      throw new Error("HTTP " + resp.status + (errText ? " — " + errText : ""));
    }
    return resp.json();
  }

  let SERVERS = [],
    byId = {},
    FOLDERS = [],
    _modal = { mode: "server", folder: null },
    _sendto = null;
  const FLEET = {};
  const ST = {
    view: "fleet",
    active: null,
    tab: "explorer",
    cwd: {},
    sel: null,
    hidden: false,
    sort: { key: "name", asc: true },
    filter: "",
    ovq: "",
    ovmode: "grid",
    ovgroup: null,
    termTabs: {},
    termActive: {},
    broadcast: false,
    sessSeq: 0,
    listing: null,
    loadSeq: 0,
    collapsed: {},
    hist: {},
    network: {},
    process: {},
    procOpen: {},
    chart: null,
    monTimer: null,
    monitorOrder: MONITOR_SECTION_ORDER.slice(),
    monitorDrag: null,
    monitorRenderPending: false,
    monitorFocusSection: null,
  };

  let toastT;
  function toast(m) {
    const toastEl = $("lt-toast");
    toastEl.textContent = m;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), TOAST_MS);
  }

  const gpus = (d) => (d && d.gpus) || [];
  const disks = (d) => (d && d.disks) || [];
  // nvidia-smi usually reports a real GPU index; fall back to the array position when absent.
  const gpuIndex = (gpu, i) => (gpu.index != null ? gpu.index : i);
  function diskPrimary(d) {
    const diskList = disks(d);
    return diskList.length
      ? diskList.reduce((largest, disk) => (disk.size > largest.size ? disk : largest))
      : null;
  }
  function gpuSummary(d) {
    const gpuList = gpus(d);
    if (!gpuList.length) return null;
    const busy = gpuList.filter((gpu) => gpu.util >= 10).length,
      idle = gpuList.filter((gpu) => gpu.util < 10).length;
    return {
      busy,
      idle,
      total: gpuList.length,
      avg: Math.round(gpuList.reduce((sum, gpu) => sum + gpu.util, 0) / gpuList.length),
    };
  }
  function statusDot(d) {
    if (!d || d.online === false) return "off";
    const summary = gpuSummary(d);
    if (!summary) return "ok";
    if (summary.idle === summary.total) return "ok";
    if (summary.avg >= 85) return "hot";
    if (summary.avg >= 70) return "warning";
    return "busy";
  }
  function tabsFor(server) {
    return server.kind === "nas"
      ? [
          ["explorer", "Explorer", "folder-open"],
          ["monitor", "Storage", "hard-drives"],
        ]
      : [
          ["explorer", "Explorer", "folder-open"],
          ["terminal", "Terminal", "terminal-window"],
          ["monitor", "Monitor", "chart-line-up"],
        ];
  }

  /* ---------------- sidebar + registry (folders, add/remove) ---------------- */
  function svCode(server) {
    if (server.kind === "wsl") return "WS";
    if (server.kind === "nas") return "NS";
    return (
      (server.name || "").replace(/[^0-9]/g, "") || (server.name || "??").slice(0, 2).toUpperCase()
    );
  }
  function svSub(server) {
    if (server.kind === "nas") return "Synology DSM";
    if (server.kind === "wsl") return "Ubuntu · WSL";
    return server.gpuLabel || server.host || "server";
  }
  function folderCollapsed(key) {
    return key in ST.collapsed ? !!ST.collapsed[key] : true;
  }
  function renderSide() {
    let free = 0;
    SERVERS.forEach((server) => {
      const gpu = gpuSummary(FLEET[server.id]);
      if (gpu && gpu.idle > 0) free++;
    });
    let html = `<div class="lt-ov${ST.view === "fleet" ? " on" : ""}" data-view="fleet"><span class="lt-app-icon">${ph("squares-four")}</span>Overview<span class="ct">${free ? free + " GPU FREE" : ""}</span></div>`;
    html += `<div class="lt-side-h"><span>MACHINES</span><span class="lt-addbtn" data-add="server" role="button" tabindex="0" aria-label="Add a server or folder" title="Add a server or folder">${ph("plus")}</span></div>`;
    (FOLDERS.length ? FOLDERS : [{ key: "lab", title: "Lab Servers" }]).forEach((f) => {
      const list = SERVERS.filter((server) => (server.group || "lab") === f.key);
      const col = folderCollapsed(f.key);
      html += `<div class="lt-sec${col ? " col" : ""}" data-grp="${esc(f.key)}"><span class="chev">${ph("caret-down")}</span><span class="lt-sec-t">${esc(f.title)}</span><span class="gn">${list.length}</span><span class="lt-sec-add" data-add="server" data-folder="${esc(f.key)}" role="button" tabindex="0" aria-label="Add server here" title="Add server here">${ph("plus")}</span></div>`;
      if (col) return;
      if (!list.length) {
        html += `<div class="lt-sv-empty">empty · <b data-add="server" data-folder="${esc(f.key)}">add server</b></div>`;
        return;
      }
      list.forEach((server) => {
        const status = FLEET[server.id],
          gpu = gpuSummary(status),
          disk = diskPrimary(status);
        let right = "";
        if (gpu && gpu.idle === gpu.total) right = '<span class="lt-sv-free">FREE</span>';
        else if (gpu)
          right = `<span class="lt-sv-pct lt-tone-${utilizationTone(gpu.avg)}">${gpu.avg}%</span>`;
        else if (disk && server.kind === "nas")
          right = `<span class="lt-sv-pct">${pct(disk.used, disk.size)}%</span>`;
        html += `<div class="lt-sv${ST.view === "server" && server.id === ST.active ? " on" : ""}" data-sv="${server.id}"><span class="lt-svi">${esc(svCode(server))}<span class="lt-st ${statusDot(status)}"></span></span><span class="lt-svt"><span class="lt-sv-name">${esc(server.name)}</span><span class="lt-sv-sub">${esc(svSub(server))}</span></span>${right}</div>`;
      });
    });
    $("lt-side").innerHTML = html;
  }
  async function refreshRegistry() {
    try {
      const [servers, folders] = await Promise.all([api("/api/servers"), api("/api/folders")]);
      SERVERS = servers;
      FOLDERS = folders;
      if (ST.ovgroup !== null && !FOLDERS.some((folder) => folder.key === ST.ovgroup)) {
        ST.ovgroup = null;
      }
      byId = Object.fromEntries(SERVERS.map((server) => [server.id, server]));
      if (ST.active && !byId[ST.active]) {
        ST.view = "fleet";
        ST.active = SERVERS[0] && SERVERS[0].id;
        ST.sel = null;
        ST.listing = null;
        renderAll();
        return;
      } // the open server was removed (e.g. config hand-edit)
      renderSide();
      if (ST.view === "fleet") viewFleet();
    } catch (e) {}
  }
  /* add server / folder modal */
  function openAddModal(mode, folder) {
    _modal = { mode: mode || "server", folder: folder || (FOLDERS[0] && FOLDERS[0].key) || "lab" };
    _ensureModal();
    renderModal();
  }
  function closeModal() {
    const element = $("lt-modal");
    if (element) element.remove();
  }
  function _ensureModal() {
    let element = $("lt-modal");
    if (!element) {
      element = document.createElement("div");
      element.id = "lt-modal";
      element.className = "lt-modal";
      (document.querySelector(".lt-window") || document.body).appendChild(element);
    }
    return element;
  }
  function openEditServer(sid) {
    const server = byId[sid];
    if (!server) return;
    _modal = { mode: "server", folder: server.group || "lab", editId: sid };
    _ensureModal();
    renderModal();
  }
  function openRenameFolder(key) {
    _modal = { mode: "folder", folder: key, editId: key };
    _ensureModal();
    renderModal();
  }
  function removeServer(id) {
    api("/api/servers/" + id, { method: "DELETE" })
      .then(() => {
        if (ST.active === id) ST.view = "fleet";
        return refreshRegistry();
      })
      .then(() => {
        renderAll();
        toast("Server removed");
      })
      .catch(() => toast("Remove failed"));
  }
  function removeFolder(key) {
    api("/api/folders/" + key, { method: "DELETE" })
      .then(() => refreshRegistry())
      .then(() => {
        renderAll();
        toast("Folder removed");
      })
      .catch(() => toast("Could not remove folder"));
  }
  function closeCtx() {
    const menu = $("lt-ctx");
    if (menu) menu.remove();
  }
  function showCtx(x, y, items) {
    closeCtx();
    const menu = document.createElement("div");
    menu.id = "lt-ctx";
    menu.className = "lt-ctx";
    menu.innerHTML = items
      .map(
        (item, i) =>
          `<div class="lt-ctx-i${item.danger ? " danger" : ""}" data-ci="${i}">${ph(contextIcon(item.label))}<span>${esc(item.label)}</span></div>`,
      )
      .join("");
    (document.querySelector(".lt-window") || document.body).appendChild(menu);
    const MENU_WIDTH = 198,
      BOTTOM_MARGIN = 14,
      ITEM_HEIGHT = 30; // ITEM_HEIGHT must track the .lt-ctx-i row height in style.css
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH)) + "px";
    menu.style.top =
      Math.max(0, Math.min(y, window.innerHeight - BOTTOM_MARGIN - items.length * ITEM_HEIGHT)) +
      "px";
    menu.addEventListener("click", (ev) => {
      const target = ev.target.closest("[data-ci]");
      if (!target) return;
      const item = items[+target.getAttribute("data-ci")];
      closeCtx();
      off();
      if (item && item.fn) item.fn();
    });
    const off = () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", esckey, true);
    };
    const close = (ev) => {
      if (!ev.target.closest("#lt-ctx")) {
        closeCtx();
        off();
      }
    };
    const esckey = (ev) => {
      if (ev.key === "Escape") {
        closeCtx();
        off();
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", close, true);
      document.addEventListener("keydown", esckey, true);
    }, 0);
  }
  function contextIcon(label) {
    const value = label.toLowerCase();
    if (value.includes("delete") || value.includes("remove")) return "trash";
    if (value.startsWith("new file")) return "file-plus";
    if (value.startsWith("new folder")) return "folder-plus";
    if (value.includes("add server")) return "plus-circle";
    if (value.includes("rename") || value.includes("edit")) return "pencil-simple";
    if (value.includes("download")) return "download-simple";
    if (value.includes("upload")) return "upload-simple";
    if (value.includes("send")) return "paper-plane-tilt";
    if (value.includes("copy")) return "copy";
    if (value.includes("terminal")) return "terminal-window";
    if (value.includes("refresh")) return "arrow-clockwise";
    if (value === "open") return "folder-open";
    return "dots-three";
  }
  function ctxFileRow(e, fileRow) {
    e.preventDefault();
    const name = fileRow.getAttribute("data-name"),
      dir = fileRow.getAttribute("data-dir") === "1";
    const cur = ST.cwd[ST.active] || "/",
      full = joinp(cur, name),
      server = byId[ST.active];
    if (!dir) {
      const entry = ((ST.listing && ST.listing.entries) || []).find((x) => x.name === name);
      ST.sel = entry
        ? { name: entry.name, dir: false, size: entry.size, mtime: entry.mtime }
        : { name, dir: false };
      const ftableBefore = document.querySelector(".lt-ftable"),
        sc = ftableBefore ? ftableBefore.scrollTop : 0;
      renderExplorer();
      const ftableAfter = document.querySelector(".lt-ftable");
      if (ftableAfter) ftableAfter.scrollTop = sc;
    }
    const items = [];
    if (dir)
      items.push({
        label: "Open",
        fn: () => {
          ST.filter = "";
          enterDir(ST.active, full);
        },
      });
    else if (server && (server.kind === "ssh" || server.kind === "nas")) {
      items.push({ label: "Download", fn: () => doDownload(ST.active, full) });
      items.push({
        label: "Send to…",
        fn: () =>
          openSendTo({ sid: ST.active, path: full, name, size: (ST.sel && ST.sel.size) || 0 }),
      });
    }
    items.push({
      label: "Rename…",
      fn: () =>
        promptM("Rename " + (dir ? "folder" : "file"), name, (nv) => {
          const er = validName(nv);
          if (er) return toast(er);
          if (nv !== name) fsOp("rename", full, joinp(cur, nv));
        }),
    });
    items.push({ label: "Copy path", fn: () => copyText(full) });
    items.push({
      label: dir ? "Delete folder" : "Delete file",
      danger: true,
      fn: () =>
        confirmM(
          `Delete ${dir ? "folder" : "file"} <b class="lt-confirm-name">${esc(name)}</b>${dir ? " <u>and everything inside it</u>" : ""}?<br>This cannot be undone.`,
          () => fsOp("delete", full),
        ),
    });
    showCtx(e.clientX, e.clientY, items);
  }
  document.addEventListener("contextmenu", (e) => {
    /* Explorer rows: full file/folder CRUD */
    const fileRow = e.target.closest(".lt-fr");
    if (fileRow && ST.view === "server" && ST.tab === "explorer") {
      ctxFileRow(e, fileRow);
      return;
    }
    /* Explorer empty space: create things here */
    const ftable = e.target.closest(".lt-ftable");
    if (ftable && ST.view === "server" && ST.tab === "explorer") {
      e.preventDefault();
      const listing = ST.listing,
        cur = ST.cwd[ST.active],
        server = byId[ST.active];
      if (!listing || listing.loading || listing.error || cur == null) {
        showCtx(e.clientX, e.clientY, [{ label: "Refresh", fn: () => loadDir(ST.active, cur) }]);
        return;
      }
      const items = [
        {
          label: "New file…",
          fn: () =>
            promptM("New file name", "", (nv) => {
              const er = validName(nv);
              if (er) return toast(er);
              fsOp("touch", joinp(cur, nv));
            }),
        },
        {
          label: "New folder…",
          fn: () =>
            promptM("New folder name", "", (nv) => {
              const er = validName(nv);
              if (er) return toast(er);
              fsOp("mkdir", joinp(cur, nv));
            }),
        },
      ];
      if (server && server.kind === "ssh")
        items.push({ label: "Upload files here…", fn: () => pickUpload() });
      items.push({ label: "Refresh", fn: () => loadDir(ST.active, cur) });
      showCtx(e.clientX, e.clientY, items);
      return;
    }
    if (!e.target.closest(".lt-side")) return;
    const serverEl = e.target.closest("[data-sv]");
    if (serverEl) {
      e.preventDefault();
      const id = serverEl.getAttribute("data-sv"),
        server = byId[id];
      showCtx(e.clientX, e.clientY, [
        { label: "Edit server…", fn: () => openEditServer(id) },
        ...(server && server.kind !== "nas"
          ? [{ label: "Open terminal", fn: () => openServer(id, "terminal") }]
          : []),
        { label: "Remove server", danger: true, fn: () => removeServer(id) },
      ]);
      return;
    }
    const section = e.target.closest("[data-grp]");
    if (section) {
      e.preventDefault();
      const key = section.getAttribute("data-grp");
      showCtx(e.clientX, e.clientY, [
        { label: "Rename folder…", fn: () => openRenameFolder(key) },
        { label: "Add server here…", fn: () => openAddModal("server", key) },
        { label: "Remove folder", danger: true, fn: () => removeFolder(key) },
      ]);
      return;
    }
  });
  function renderModal() {
    const element = $("lt-modal");
    if (!element) return;
    const mode = _modal.mode,
      editId = _modal.editId,
      server = editId && mode === "server" ? byId[editId] || {} : {};
    const folderOptions = FOLDERS.map(
      (f) =>
        `<option value="${esc(f.key)}" ${f.key === _modal.folder ? "selected" : ""}>${esc(f.title)}</option>`,
    ).join("");
    const kindSelected = (k) => (server.kind === k ? "selected" : "");
    let body;
    if (mode === "folder") {
      const curTitle = editId ? (FOLDERS.find((f) => f.key === editId) || {}).title || "" : "";
      body = `<label class="lt-f-l">Folder name</label><input class="lt-f-in" id="m-fname" placeholder="e.g. Cloud GPUs" value="${esc(curTitle)}">`;
    } else {
      body = `<div class="lt-f-grid"><div><label class="lt-f-l">Kind</label><select class="lt-f-in" id="m-kind"><option value="ssh" ${kindSelected("ssh")}>SSH server</option><option value="wsl" ${kindSelected("wsl")}>WSL</option><option value="nas" ${kindSelected("nas")}>Synology NAS</option></select></div><div><label class="lt-f-l">Name</label><input class="lt-f-in" id="m-name" placeholder="Exp19" value="${esc(server.name || "")}"></div><div><label class="lt-f-l">Host / IP</label><input class="lt-f-in" id="m-host" placeholder="133.9.48.110" value="${esc(server.host || "")}"></div><div><label class="lt-f-l">Port</label><input class="lt-f-in" id="m-port" placeholder="22" value="${esc(server.port != null ? server.port : "")}"></div><div><label class="lt-f-l">User</label><input class="lt-f-in" id="m-user" placeholder="yue_ziran" value="${esc(server.user || "")}"></div><div><label class="lt-f-l">Label (GPU / role)</label><input class="lt-f-in" id="m-gpu" placeholder="RTX 4090" value="${esc(server.gpuLabel || "")}"></div><div class="lt-f-wide"><label class="lt-f-l">Folder</label><select class="lt-f-in" id="m-folder">${folderOptions}</select></div></div>`;
    }
    const head = editId
      ? `<b class="lt-modal-title">${mode === "folder" ? "Rename folder" : "Edit server"}</b>`
      : `<div class="lt-seg"><span class="${mode === "server" ? "on" : ""}" data-mode="server">Server</span><span class="${mode === "folder" ? "on" : ""}" data-mode="folder">Folder</span></div>`;
    const btn = editId ? "Save" : "Add " + (mode === "folder" ? "folder" : "server");
    element.innerHTML = `<div class="lt-modal-card"><div class="lt-modal-h">${head}<span class="lt-modal-x" data-mclose="1" role="button" tabindex="0" aria-label="Close dialog">${ph("x")}</span></div><div class="lt-modal-b">${body}</div><div class="lt-modal-f"><span class="lt-btn ghost" data-mclose="1">Cancel</span><span class="lt-btn" data-msubmit="1">${btn}</span></div></div>`;
    const firstInput = element.querySelector(".lt-f-in");
    if (firstInput) firstInput.focus();
  }
  async function submitFolder(editId) {
    const title = (($("m-fname") || {}).value || "").trim();
    if (!title) {
      toast("Folder name required");
      return;
    }
    if (editId) {
      await api("/api/folders/" + editId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      closeModal();
      await refreshRegistry();
      renderAll();
      toast("Folder renamed");
      return;
    }
    await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    closeModal();
    await refreshRegistry();
    toast("Folder “" + title + "” added");
    return;
  }
  async function submitAdd() {
    if (submitAdd._busy) return;
    submitAdd._busy = true;
    try {
      const editId = _modal.editId;
      // await inside the try so submitFolder's API errors hit this catch and _busy
      // (the re-entrancy guard) stays set until the folder request actually finishes
      if (_modal.mode === "folder") {
        await submitFolder(editId);
        return;
      }
      const fieldValue = (id) => (($(id) || {}).value || "").trim();
      const name = fieldValue("m-name");
      if (!name) {
        toast("Name required");
        return;
      }
      const group = fieldValue("m-folder") || _modal.folder || "lab";
      const payload = {
        name,
        kind: fieldValue("m-kind") || "ssh",
        host: fieldValue("m-host"),
        port: fieldValue("m-port"),
        user: fieldValue("m-user"),
        gpuLabel: fieldValue("m-gpu"),
        group,
      };
      if (editId) {
        const server = await api("/api/servers/" + editId, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        closeModal();
        await refreshRegistry();
        renderAll();
        toast("Saved “" + ((server && server.name) || name) + "”");
        return;
      }
      const server = await api("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      ST.collapsed[group] = false;
      try {
        localStorage.setItem("lt-collapsed", JSON.stringify(ST.collapsed));
      } catch (e) {}
      closeModal();
      await refreshRegistry();
      toast("Server “" + ((server && server.name) || name) + "” added");
    } catch (e) {
      toast("Save failed: " + e);
    } finally {
      submitAdd._busy = false;
    }
  }

  /* ---------------- header + tabs ---------------- */
  function renderHeadTabs() {
    const head = $("lt-shead"),
      tabs = $("lt-subtabs");
    if (ST.view === "fleet") {
      head.innerHTML = "";
      tabs.innerHTML = "";
      return;
    }
    const server = byId[ST.active],
      status = FLEET[ST.active] || {},
      gpu = gpuSummary(status),
      disk = diskPrimary(status);
    let chips = "";
    if (status.online === false) chips += `<span class="lt-chip destructive">offline</span>`;
    else if (gpu) {
      let chipKind;
      if (gpu.avg >= 85) chipKind = "destructive";
      else if (gpu.avg >= 70) chipKind = "warning";
      else if (gpu.idle === gpu.total) chipKind = "ok";
      else chipKind = "busy";
      chips += `<span class="lt-chip ${chipKind}">${gpu.total > 1 ? gpu.total + "× GPU" : "GPU"} · ${gpus(
        status,
      )
        .map((x) => x.util + "%")
        .join(" / ")}</span>`;
    } else if (server.kind === "ssh" && status.ncpu)
      chips += `<span class="lt-chip">${status.ncpu} cores · load ${status.load[0]}</span>`;
    if (disk)
      chips += `<span class="lt-chip">${server.kind === "nas" ? "volume" : "disk"} ${pct(disk.used, disk.size)}%</span>`;
    if (status.online !== false) chips += `<span class="lt-chip ok">${ph("pulse")}live</span>`;
    let addr;
    if (server.kind === "nas") addr = `${server.host}:${server.port}`;
    else if (server.kind === "wsl") addr = "wsl · Ubuntu";
    else addr = `${server.user}@${server.host}:${server.port}`;
    head.innerHTML = `<span class="lt-st lt-head-dot ${statusDot(status)}"></span><span class="hnm">${esc(server.name)}</span><span class="hsub">${esc(addr)}${status.up ? " · up " + status.up : ""}</span><div class="chips">${chips}</div>`;
    tabs.innerHTML = tabsFor(server)
      .map(
        ([k, lbl, icon]) =>
          `<div class="tab${ST.tab === k ? " on" : ""}" data-tab="${k}"><span class="lt-app-icon">${ph(icon)}</span>${lbl}</div>`,
      )
      .join("");
  }

  /* ---------------- hosts overview ---------------- */
  function hostMeta(server) {
    const status = FLEET[server.id],
      gpu = gpuSummary(status),
      disk = diskPrimary(status);
    let code;
    if (server.kind === "wsl") code = "WS";
    else if (server.kind === "nas") code = "NS";
    else code = server.name.replace(/[^0-9]/g, "") || server.name.slice(0, 2).toUpperCase();
    let addr;
    if (server.kind === "wsl") addr = (server.user || "wsl") + " · Ubuntu";
    else if (server.kind === "nas") addr = `${server.host}:${server.port}`;
    else addr = `${server.user}@${server.host}:${server.port}`;
    let statusText;
    if (!status) statusText = "connecting…";
    else if (status.online === false)
      statusText = "offline" + (status.error ? " · " + status.error : "");
    else if (gpu)
      statusText =
        `GPU ${gpu.avg}% · ${gpu.idle > 0 ? gpu.idle + " idle" : "all busy"}` +
        (disk ? ` · disk ${pct(disk.used, disk.size)}%` : "");
    else if (server.kind === "nas")
      statusText = disk
        ? `volume ${pct(disk.used, disk.size)}% · ${bytes(disk.size - disk.used)} free`
        : "—";
    else
      statusText =
        (status.ncpu ? `load ${status.load[0]} · ${status.ncpu} cores` : "idle") +
        (disk ? ` · disk ${pct(disk.used, disk.size)}%` : "");
    return { status, gpu, code, addr, statusText };
  }
  function hostCard(s) {
    const meta = hostMeta(s);
    let tags = `<span class="lt-htag">${esc(s.gpuLabel || s.kind)}</span>`;
    if (meta.gpu && meta.gpu.idle > 0)
      tags += `<span class="lt-htag free">${meta.gpu.idle} GPU FREE</span>`;
    return `<div class="lt-hcard" data-sv="${s.id}"><div class="lt-hgo">Open →</div><div class="lt-htop"><span class="lt-hicon">${esc(meta.code)}<span class="lt-st ${statusDot(meta.status)}"></span></span><div class="lt-hmeta"><div class="lt-hname">${esc(s.name)}</div><div class="lt-haddr">${esc(meta.addr)}</div></div></div><div class="lt-htags">${tags}</div><div class="lt-hstat">${esc(meta.statusText)}</div></div>`;
  }
  function hostRow(s) {
    const meta = hostMeta(s);
    const tag =
      meta.gpu && meta.gpu.idle > 0
        ? `<span class="lt-htag free">${meta.gpu.idle} FREE</span>`
        : `<span class="lt-htag">${esc(s.gpuLabel || s.kind)}</span>`;
    return `<div class="lt-hrow" data-sv="${s.id}"><span class="lt-hicon sm">${esc(meta.code)}<span class="lt-st ${statusDot(meta.status)}"></span></span><div class="lt-rmeta"><span class="lt-hname">${esc(s.name)}</span><span class="lt-haddr">${esc(meta.addr)}</span></div><span class="lt-rstat">${esc(meta.statusText)}</span>${tag}<span class="lt-hgo2">Open →</span></div>`;
  }
  function viewFleet() {
    const focusedGroupControl =
      document.activeElement && document.activeElement.closest
        ? document.activeElement.closest("[data-ov-group-control]")
        : null;
    const focusedGroup = focusedGroupControl
      ? focusedGroupControl.getAttribute("data-ov-group")
      : null,
      focusedSearch = document.activeElement && document.activeElement.id === "lt-ovsearch",
      searchSelectionStart = focusedSearch ? document.activeElement.selectionStart : null,
      searchSelectionEnd = focusedSearch ? document.activeElement.selectionEnd : null;
    const query = (ST.ovq || "").toLowerCase();
    const list = SERVERS.filter(
      (s) =>
        (ST.ovgroup === null || (s.group || "lab") === ST.ovgroup) &&
        (!query ||
          (s.name + " " + s.host + " " + (s.gpuLabel || "")).toLowerCase().includes(query)),
    );
    const mode = ST.ovmode === "list" ? "list" : "grid",
      countLabel =
        list.length === SERVERS.length
          ? `${SERVERS.length} machines`
          : `${list.length}/${SERVERS.length} machines`,
      groupControls = [
        `<button type="button" class="${ST.ovgroup === null ? "on" : ""}" data-ov-group-control aria-pressed="${ST.ovgroup === null}">All</button>`,
        ...FOLDERS.map(
          (folder) =>
            `<button type="button" class="${ST.ovgroup === folder.key ? "on" : ""}" data-ov-group-control data-ov-group="${esc(folder.key)}" aria-pressed="${ST.ovgroup === folder.key}">${esc(folder.title)}</button>`,
        ),
      ].join("");
    let html =
      `<div class="lt-ovh"><h3>Hosts</h3><span class="ct">${countLabel} · key auth</span>` +
      `<div class="lt-ovgroup" role="group" aria-label="Host group">${groupControls}</div>` +
      `<div class="lt-vtog"><span class="lt-vbtn${mode === "grid" ? " on" : ""}" data-ov="grid" role="button" tabindex="0" aria-label="Grid view" aria-pressed="${mode === "grid"}" title="Grid view">${ph("squares-four")}</span><span class="lt-vbtn${mode === "list" ? " on" : ""}" data-ov="list" role="button" tabindex="0" aria-label="List view" aria-pressed="${mode === "list"}" title="List view">${ph("list")}</span></div>` +
      `<input class="lt-ovsearch" id="lt-ovsearch" placeholder="Search hosts…" value="${esc(ST.ovq || "")}"></div>`;
    if (!list.length) {
      const selectedFolder = FOLDERS.find((folder) => folder.key === ST.ovgroup);
      let emptyMessage;
      if (query && selectedFolder)
        emptyMessage = `No hosts in “${selectedFolder.title}” match “${ST.ovq}”.`;
      else if (query) emptyMessage = `No hosts match “${ST.ovq}”.`;
      else if (selectedFolder) emptyMessage = `No hosts in “${selectedFolder.title}”.`;
      else emptyMessage = "No hosts configured.";
      html += `<div class="lt-empty">${esc(emptyMessage)}</div>`;
    } else if (mode === "list")
      html += '<div class="lt-hlist">' + list.map((s) => hostRow(s)).join("") + "</div>";
    else html += '<div class="lt-hgrid">' + list.map((s) => hostCard(s)).join("") + "</div>";
    const viewEl = $("lt-view");
    viewEl.className = "lt-view pad";
    viewEl.innerHTML = html;
    if (focusedGroupControl) {
      const controls = Array.from(viewEl.querySelectorAll("[data-ov-group-control]"));
      const control =
        controls.find((candidate) => candidate.getAttribute("data-ov-group") === focusedGroup) ||
        controls.find((candidate) =>
          ST.ovgroup === null
            ? !candidate.hasAttribute("data-ov-group")
            : candidate.getAttribute("data-ov-group") === ST.ovgroup,
        );
      if (control) control.focus();
    } else if (focusedSearch) {
      const search = $("lt-ovsearch");
      search.focus();
      search.setSelectionRange(searchSelectionStart, searchSelectionEnd);
    }
  }

  /* ---------------- explorer ---------------- */
  function crumbHtml(id, path) {
    const server = byId[id];
    const parts = (path || "/").split("/").filter(Boolean);
    let html = `<span class="seg root" data-go="/">${esc(server.name)}</span>`;
    let acc = "";
    parts.forEach((p, i) => {
      acc += "/" + p;
      html += `<span class="sep">/</span><span class="seg${i === parts.length - 1 ? " root" : ""}" data-go="${esc(acc)}">${esc(p)}</span>`;
    });
    return html;
  }
  /* file icons: devicon for known code/config types, shapes for folder/symlink/other */
  const _DEVEXT = {
    py: "python-plain",
    pyw: "python-plain",
    ipynb: "jupyter-plain",
    js: "javascript-plain",
    mjs: "javascript-plain",
    cjs: "javascript-plain",
    ts: "typescript-plain",
    tsx: "react-original",
    jsx: "react-original",
    rs: "rust-original",
    go: "go-plain",
    c: "c-plain",
    h: "c-plain",
    cpp: "cplusplus-plain",
    cc: "cplusplus-plain",
    cxx: "cplusplus-plain",
    hpp: "cplusplus-plain",
    hh: "cplusplus-plain",
    java: "java-plain",
    kt: "kotlin-plain",
    kts: "kotlin-plain",
    rb: "ruby-plain",
    php: "php-plain",
    cs: "csharp-plain",
    swift: "swift-plain",
    sh: "bash-plain",
    bash: "bash-plain",
    zsh: "bash-plain",
    csh: "bash-plain",
    ps1: "powershell-plain",
    psm1: "powershell-plain",
    html: "html5-plain",
    htm: "html5-plain",
    css: "css3-plain",
    scss: "sass-original",
    sass: "sass-original",
    json: "json-plain",
    yaml: "yaml-plain",
    yml: "yaml-plain",
    md: "markdown-original",
    markdown: "markdown-original",
    tex: "latex-original",
    r: "r-plain",
    lua: "lua-plain",
    vim: "vim-plain",
    sql: "mysql-original",
    db: "sqlite-plain",
    sqlite: "sqlite-plain",
  };
  const _DEVNAME = {
    dockerfile: "docker-plain",
    "docker-compose.yml": "docker-plain",
    "docker-compose.yaml": "docker-plain",
    ".gitignore": "git-plain",
    ".gitconfig": "git-plain",
    ".gitattributes": "git-plain",
    "package.json": "nodejs-plain",
    ".bashrc": "bash-plain",
    ".zshrc": "bash-plain",
    ".bash_history": "bash-plain",
    ".vimrc": "vim-plain",
    ".profile": "bash-plain",
  };
  function devClass(name) {
    const lower = name.toLowerCase();
    if (_DEVNAME[lower]) return _DEVNAME[lower];
    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 ? lower.slice(dot + 1) : "";
    return _DEVEXT[ext] || null;
  }
  function fileIcon(name, isdir, islink) {
    if (isdir) return '<span class="lt-ic dir" aria-hidden="true"></span>';
    if (islink) return '<span class="lt-ic lnk" aria-hidden="true"></span>';
    const dev = devClass(name);
    return dev
      ? `<i class="lt-di devicon-${dev} colored" aria-hidden="true"></i>`
      : '<span class="lt-ic fil" aria-hidden="true"></span>';
  }
  async function loadDir(id, path) {
    const seq = ++ST.loadSeq;
    ST.listing = { id, path: path || "", loading: true };
    if (ST.view === "server" && ST.tab === "explorer" && ST.active === id) renderExplorer();
    const url = path != null ? `/api/${id}/ls?path=${encodeURIComponent(path)}` : `/api/${id}/ls`;
    let resp;
    try {
      resp = await api(url);
    } catch (err) {
      resp = { error: String(err), entries: [], path: path || "/" };
    }
    if (seq !== ST.loadSeq) return;
    ST.cwd[id] = resp.path; // authoritative path from backend (resolves $HOME)
    ST.listing = {
      id,
      path: resp.path,
      loading: false,
      entries: resp.entries || [],
      error: resp.error,
      parent: resp.parent,
    };
    if (ST.view === "server" && ST.tab === "explorer" && ST.active === id) renderExplorer();
  }
  function viewExplorer() {
    const id = ST.active,
      want = ST.cwd[id];
    if (!ST.listing || ST.listing.id !== id || (want != null && ST.listing.path !== want)) {
      loadDir(id, want);
      return;
    }
    renderExplorer();
  }
  function renderExplorer() {
    const id = ST.active,
      server = byId[id],
      path = ST.cwd[id],
      listing = ST.listing;
    const parent = (listing && listing.parent) || parentOf(path);
    const fwd = (ST.navFwd && ST.navFwd[id]) || [];
    const backDim = path === "/" || !path || parent === path ? " dim" : "";
    const fwdDim = fwd.length ? "" : " dim";
    const top = `<div class="lt-toolbar"><span class="lt-nav${backDim}" data-act="up" role="button" tabindex="0" aria-label="Parent folder" title="Parent folder">${ph("arrow-up")}</span><span class="lt-nav${fwdDim}" data-act="fwd" role="button" tabindex="0" aria-label="Forward" title="Forward — back to where you came from">${ph("arrow-right")}</span><span class="lt-nav" data-act="refresh" role="button" tabindex="0" aria-label="Refresh" title="Refresh">${ph("arrow-clockwise")}</span>${server.kind === "ssh" ? `<span class="lt-nav" data-act="upload" role="button" tabindex="0" aria-label="Upload files here" title="Upload files here">${ph("upload-simple")}</span>` : ""}<div class="lt-crumb">${crumbHtml(id, path)}</div><input class="lt-filter" id="lt-filter" placeholder="filter…" value="${esc(ST.filter)}"><label class="lt-chk"><input type="checkbox" id="lt-hidden" ${ST.hidden ? "checked" : ""}>HIDDEN</label></div>`;
    let body;
    if (listing && listing.loading) {
      body = `<div class="lt-ftable"><div class="lt-empty">Listing <b>${esc(server.name)}:${esc(path)}</b> …</div></div>`;
    } else if (listing && listing.error) {
      body = `<div class="lt-ftable"><div class="lt-empty"><b>Couldn’t list this folder.</b><br>${esc(listing.error)}</div></div>`;
    } else {
      const arrow = ph(ST.sort.asc ? "caret-up" : "caret-down");
      let table = `<div class="lt-fh"><span data-sort="name">NAME ${ST.sort.key === "name" ? '<span class="ar">' + arrow + "</span>" : ""}</span><span class="lt-col-end" data-sort="size">SIZE ${ST.sort.key === "size" ? '<span class="ar">' + arrow + "</span>" : ""}</span><span class="lt-col-end" data-sort="mtime">MODIFIED ${ST.sort.key === "mtime" ? '<span class="ar">' + arrow + "</span>" : ""}</span></div>`;
      let items = ((listing && listing.entries) || []).slice();
      if (!ST.hidden)
        items = items.filter((entry) => !entry.name.startsWith(".") && entry.name !== "#recycle");
      if (ST.filter)
        items = items.filter((entry) => entry.name.toLowerCase().includes(ST.filter.toLowerCase()));
      const sortKey = ST.sort.key,
        asc = ST.sort.asc ? 1 : -1;
      items.sort((a, b) => {
        if (a.isdir !== b.isdir) return a.isdir ? -1 : 1;
        let x, y;
        if (sortKey === "name") {
          x = a.name.toLowerCase();
          y = b.name.toLowerCase();
        } else if (sortKey === "size") {
          x = a.isdir ? -1 : a.size;
          y = b.isdir ? -1 : b.size;
        } else {
          x = a.mtime;
          y = b.mtime;
        }
        if (x < y) return -asc;
        if (x > y) return asc;
        return 0;
      });
      if (!items.length)
        table += `<div class="lt-empty">Empty folder${ST.filter ? " (filter active)" : ""}.</div>`;
      items.forEach((entry) => {
        const isHid = entry.name.startsWith(".");
        const selCls = ST.sel && ST.sel.name === entry.name ? " sel" : "";
        table += `<div class="lt-fr${selCls}${isHid ? " hid" : ""}" data-name="${esc(entry.name)}" data-dir="${entry.isdir ? 1 : 0}"><span class="nm">${fileIcon(entry.name, entry.isdir, entry.islink)}<span class="nmtx">${esc(entry.name)}</span></span><span class="sz">${entry.isdir ? "—" : bytes(entry.size)}</span><span class="dt">${entry.mtime ? ago(entry.mtime) : ""}</span></div>`;
      });
      body = `<div class="lt-ftable">${table}</div>${prevHtml(id)}`;
    }
    const v = $("lt-view");
    v.className = "lt-view flexcol";
    v.innerHTML = top + `<div class="lt-files-body">${body}</div>`;
  }
  function listingSource(kind) {
    if (kind === "nas") return "the Synology API";
    if (kind === "wsl") return "wsl.exe";
    return "SSH / SFTP";
  }
  function prevHtml(id) {
    const server = byId[id];
    if (!ST.sel)
      return `<aside class="lt-prev"><div class="pic">${ph("files")}</div><h4>Nothing selected</h4><div class="meta">Click a file to preview.<br>Click a folder to open it.</div><div class="lt-hint">Live listing over ${listingSource(server.kind)}.</div></aside>`;
    const entry = ST.sel;
    if (entry.dir)
      return `<aside class="lt-prev"><div class="pic">${ph("folder-open")}</div><h4>${esc(entry.name)}</h4><div class="meta">Folder · ${esc(server.name)}<br>${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="open">Open</span><span class="lt-act" data-act="copypath">Copy path</span>${server.kind !== "nas" ? '<span class="lt-act" data-act="newterm">Open terminal here</span>' : ""}</aside>`;
    const ext = (entry.name.split(".").pop() || "").toLowerCase();
    return `<aside class="lt-prev"><div class="pic">${ph("file")}</div><h4>${esc(entry.name)}</h4><div class="meta">${bytes(entry.size)} · ${esc(ext || "file")}<br>${entry.mtime ? "modified " + ago(entry.mtime) : ""}<br>${esc(server.name)}:${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="sendto">Send to…</span><span class="lt-act" data-act="download">Download</span><span class="lt-act" data-act="copypath">Copy path</span></aside>`;
  }

  /* ---------------- explorer file CRUD (context menu + dialogs) ---------------- */
  function joinp(dir, name) {
    return (dir === "/" || dir === "" || dir == null ? "" : dir) + "/" + name;
  }
  // A new navigation invalidates the forward path, so reset the host's forward stack.
  function clearForwardHistory(id) {
    (ST.navFwd || (ST.navFwd = {}))[id] = [];
  }
  // Open `path` on host `id`: drop the selection + forward history, then load the listing.
  // ST.filter is left untouched — callers navigating out of a filtered list clear it themselves.
  function enterDir(id, path) {
    ST.cwd[id] = path;
    clearForwardHistory(id);
    ST.sel = null;
    loadDir(id, path);
  }
  function validName(n) {
    n = (n || "").trim();
    if (!n) return "Name cannot be empty";
    if (n === "." || n === "..") return "Invalid name";
    if (n.indexOf("/") >= 0) return "Name can’t contain “/”";
    if (/[ -]/.test(n)) return "Invalid name";
    return null;
  }
  async function fsOp(op, path, to) {
    const sid = ST.active,
      cwd = ST.cwd[sid];
    try {
      await api("/api/" + sid + "/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, path, to }),
      });
      toast(
        { mkdir: "Folder created", touch: "File created", rename: "Renamed", delete: "Deleted" }[
          op
        ] || "Done",
      );
      if (ST.active === sid) {
        ST.sel = null;
        loadDir(sid, cwd);
      }
    } catch (err) {
      toast("Failed: " + (err.message || err));
    }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(
        () => toast("Copied — " + text),
        () => toast(text),
      );
    else toast(text);
  }
  function _dlg(html) {
    let modal = $("lt-prompt");
    if (modal) modal.remove();
    modal = document.createElement("div");
    modal.id = "lt-prompt";
    modal.className = "lt-modal";
    modal.innerHTML = html;
    (document.querySelector(".lt-window") || document.body).appendChild(modal);
    return modal;
  }
  function promptM(title, initial, cb) {
    const modal = _dlg(
      `<div class="lt-modal-card"><div class="lt-modal-h"><b class="lt-modal-title">${esc(title)}</b><span class="lt-modal-x" data-pclose="1" role="button" tabindex="0" aria-label="Close dialog">${ph("x")}</span></div><div class="lt-modal-b"><input class="lt-f-in" id="lt-prompt-in" value="${esc(initial || "")}" spellcheck="false"></div><div class="lt-modal-f"><span class="lt-btn ghost" data-pclose="1">Cancel</span><span class="lt-btn" data-pok="1">OK</span></div></div>`,
    );
    const inp = $("lt-prompt-in");
    inp.focus();
    if (initial) {
      const dot = initial.lastIndexOf(".");
      inp.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
    const done = (ok) => {
      const value = inp.value.trim();
      modal.remove();
      if (ok && value) cb(value);
    };
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal || ev.target.closest("[data-pclose]")) done(false);
      else if (ev.target.closest("[data-pok]")) done(true);
    });
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        done(true);
      } else if (ev.key === "Escape") done(false);
    });
  }
  function confirmM(html, cb) {
    const modal = _dlg(
      `<div class="lt-modal-card"><div class="lt-modal-h"><b class="lt-modal-title">Are you sure?</b><span class="lt-modal-x" data-pclose="1" role="button" tabindex="0" aria-label="Close dialog">${ph("x")}</span></div><div class="lt-modal-b lt-modal-copy">${html}</div><div class="lt-modal-f"><span class="lt-btn ghost" data-pclose="1">Cancel</span><span class="lt-btn destructive" data-pok="1">Delete</span></div></div>`,
    );
    const close = () => {
      modal.remove();
      document.removeEventListener("keydown", key, true);
    };
    const key = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        close();
        cb();
      }
    };
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal || ev.target.closest("[data-pclose]")) close();
      else if (ev.target.closest("[data-pok]")) {
        close();
        cb();
      }
    });
    document.addEventListener("keydown", key, true);
  }

  /* ---------------- transfers (queue drawer + actions) ---------------- */
  function xfer() {
    return ST.xfer || (ST.xfer = { open: false, jobs: [], timer: null });
  }
  async function xferTick() {
    let resp;
    try {
      resp = await api("/api/transfers");
    } catch (e) {
      return;
    }
    const state = xfer();
    state.jobs = resp.jobs || [];
    const activeCount = state.jobs.filter(
      (job) => job.state === "active" || job.state === "queued",
    ).length;
    const badge = $("lt-xfer-n");
    if (badge) {
      badge.textContent = activeCount || "";
      badge.classList.toggle("on", !!activeCount);
    }
    if (state.open) renderDrawer();
  }
  function startXfer() {
    const state = xfer();
    if (state.timer) return;
    state.timer = setInterval(xferTick, TRANSFER_POLL_MS);
    xferTick();
  }
  function toggleDrawer(open) {
    const state = xfer();
    state.open = open != null ? open : !state.open;
    if (state.open) startXfer();
    renderDrawer();
  }
  function xferDirIcon(kind) {
    if (kind === "upload") return ph("arrow-up");
    if (kind === "download") return ph("arrow-down");
    return ph("arrow-right");
  }
  function xferStateTone(state) {
    if (state === "error") return "destructive";
    if (state === "done") return "online";
    if (state === "canceled") return "muted";
    return "primary";
  }
  function xferPct(j) {
    if (j.total) return Math.min(100, Math.round((j.done / j.total) * 100));
    return j.state === "done" ? 100 : 0;
  }
  function xferProgressLabel(job, percent) {
    if (job.state === "active") {
      const speedPrefix = job.speed > 0 ? bytes(job.speed) + "/s · " : "";
      return speedPrefix + percent + "%";
    }
    if (job.error) return esc(job.error);
    return percent + "%";
  }
  function renderDrawer() {
    const state = xfer(),
      drawerEl = $("lt-drawer");
    if (!drawerEl) return;
    drawerEl.hidden = !state.open;
    if (!state.open) return;
    const rows =
      state.jobs
        .slice()
        .reverse()
        .map((job) => {
          const percent = xferPct(job);
          const dirIcon = xferDirIcon(job.kind);
          const stateTone = xferStateTone(job.state);
          const isActive = job.state === "active" || job.state === "queued";
          return `<div class="lt-xrow"><div class="lt-xtop"><span class="lt-xlabel" title="${esc(job.label)}">${dirIcon} ${esc(job.label)}</span>${isActive ? `<span class="lt-xcancel" data-xcancel="${job.id}" role="button" tabindex="0" aria-label="Cancel transfer" title="Cancel">${ph("x")}</span>` : `<span class="lt-xstate lt-tone-${stateTone}">${job.state}</span>`}</div><div class="lt-xbar"><span class="lt-xfill lt-tone-${stateTone}" style="width:${percent}%"></span></div><div class="lt-xsub"><span>${job.total ? bytes(job.done) + " / " + bytes(job.total) : bytes(job.done)}</span><span>${xferProgressLabel(job, percent)}</span></div></div>`;
        })
        .join("") ||
      '<div class="lt-xempty">No transfers yet.<br>Use “Send to…”, “Download”, or “Upload”.</div>';
    drawerEl.innerHTML = `<div class="lt-xhead"><b>Transfers</b><span class="lt-grow"></span><span class="lt-xbtn" data-xfer="clear">Clear done</span><span class="lt-xbtn lt-icon-control" data-xclose="1" role="button" tabindex="0" aria-label="Close transfers">${ph("x")}</span></div><div class="lt-xbody">${rows}</div>`;
  }
  function doDownload(id, path) {
    const a = document.createElement("a");
    a.href = "/api/" + id + "/download?path=" + encodeURIComponent(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading " + (path.split("/").pop() || "file") + "…");
  }
  function openSendTo(src) {
    _sendto = src;
    let modalEl = $("lt-sendto");
    if (!modalEl) {
      modalEl = document.createElement("div");
      modalEl.id = "lt-sendto";
      modalEl.className = "lt-modal";
      (document.querySelector(".lt-window") || document.body).appendChild(modalEl);
    }
    const destinations = SERVERS.filter((server) => server.kind === "ssh" || server.kind === "nas");
    const options = destinations
      .map(
        (server) =>
          `<option value="${esc(server.id)}">${esc(server.name)}${server.kind === "nas" ? " · NAS" : ""}</option>`,
      )
      .join("");
    const defaultDest = destinations[0];
    modalEl.innerHTML = `<div class="lt-modal-card"><div class="lt-modal-h"><b class="lt-modal-title">Send “${esc(src.name)}”</b><span class="lt-modal-x" data-sclose="1" role="button" tabindex="0" aria-label="Close dialog">${ph("x")}</span></div><div class="lt-modal-b"><div class="lt-f-grid"><div class="lt-f-wide"><label class="lt-f-l">Destination host</label><select class="lt-f-in" id="st-host">${options}</select></div><div class="lt-f-wide"><label class="lt-f-l">Destination folder</label><input class="lt-f-in" id="st-path" value="${esc((defaultDest && defaultDest.home) || "/")}" placeholder="/home/you"></div></div><div class="lt-hint">Copies over the lab network (server→server or →NAS), streamed with live progress in Transfers.</div></div><div class="lt-modal-f"><span class="lt-btn ghost" data-sclose="1">Cancel</span><span class="lt-btn" data-ssubmit="1">Send</span></div></div>`;
    const hostSelect = $("st-host");
    if (hostSelect)
      hostSelect.onchange = () => {
        const dest = byId[hostSelect.value],
          pathInput = $("st-path");
        if (dest && pathInput) pathInput.value = dest.home || "/";
      };
    const pathInput = $("st-path");
    if (pathInput) pathInput.focus();
  }
  function closeSendTo() {
    const modalEl = $("lt-sendto");
    if (modalEl) modalEl.remove();
  }
  async function submitSendTo() {
    const src = _sendto;
    if (!src) return;
    const sid = ($("st-host") || {}).value || "";
    const path = (($("st-path") || {}).value || "").trim();
    if (!sid || !path) {
      toast("Pick a destination folder");
      return;
    }
    try {
      await api("/api/transfers/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          src: { sid: src.sid, path: src.path, name: src.name, size: src.size || 0 },
          dst: { sid, path },
        }),
      });
      closeSendTo();
      toggleDrawer(true);
      toast("Transfer queued");
    } catch (e) {
      toast("Send failed: " + e);
    }
  }
  function pickUpload() {
    const id = ST.active,
      server = byId[id];
    if (!server || server.kind !== "ssh") {
      toast("Upload supported on SSH hosts (for now)");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => uploadFiles(id, ST.cwd[id] || "/", [...input.files]);
    input.click();
  }
  async function uploadFiles(id, dir, files) {
    const server = byId[id];
    if (!server || server.kind !== "ssh") {
      toast("Upload supported on SSH hosts (for now)");
      return;
    }
    if (!files || !files.length) return;
    toggleDrawer(true);
    for (const file of files) {
      try {
        await fetch(
          "/api/" +
            id +
            "/upload?path=" +
            encodeURIComponent(dir) +
            "&name=" +
            encodeURIComponent(file.name),
          { method: "POST", body: file },
        );
      } catch (e) {
        toast("Upload failed: " + file.name);
      }
      xferTick();
    }
    toast("Upload complete");
    if (ST.view === "server" && ST.active === id && ST.tab === "explorer") loadDir(id, ST.cwd[id]);
  }
  document.addEventListener("dragover", (e) => {
    if (e.target.closest && e.target.closest(".lt-files-body")) {
      e.preventDefault();
    }
  });
  document.addEventListener("drop", (e) => {
    const z = e.target.closest && e.target.closest(".lt-files-body");
    if (z && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      uploadFiles(ST.active, ST.cwd[ST.active] || "/", [...e.dataTransfer.files]);
    }
  });

  /* ---------------- terminal (real PTY · multi-session · broadcast · search · drop-file) ---------------- */
  const SESS = {}; // sessionKey -> {key,host,term,fit,search,ws,wrap,connected,ro}
  const _enc = new TextEncoder();
  function xtermTheme() {
    const styles = getComputedStyle(document.querySelector(".lt-window"));
    const token = (name) => styles.getPropertyValue(name).trim();
    const background = token("--terminal-background"),
      foreground = token("--terminal-foreground"),
      cursor = token("--terminal-cursor"),
      cursorAccent = token("--terminal-cursor-accent"),
      selectionBackground = token("--terminal-selection"),
      selectionForeground = token("--terminal-selection-foreground"),
      terminalBlack = token("--terminal-black"),
      terminalRed = token("--terminal-red"),
      terminalGreen = token("--terminal-green"),
      terminalYellow = token("--terminal-yellow"),
      terminalBlue = token("--terminal-blue"),
      terminalMagenta = token("--terminal-magenta"),
      terminalCyan = token("--terminal-cyan"),
      terminalWhite = token("--terminal-white"),
      terminalBrightBlack = token("--terminal-bright-black"),
      terminalBrightRed = token("--terminal-bright-red"),
      terminalBrightGreen = token("--terminal-bright-green"),
      terminalBrightYellow = token("--terminal-bright-yellow"),
      terminalBrightBlue = token("--terminal-bright-blue"),
      terminalBrightMagenta = token("--terminal-bright-magenta"),
      terminalBrightCyan = token("--terminal-bright-cyan"),
      terminalBrightWhite = token("--terminal-bright-white");
    return {
      background,
      foreground,
      cursor,
      cursorAccent,
      selectionBackground,
      selectionForeground,
      black: terminalBlack,
      red: terminalRed,
      green: terminalGreen,
      yellow: terminalYellow,
      blue: terminalBlue,
      magenta: terminalMagenta,
      cyan: terminalCyan,
      white: terminalWhite,
      brightBlack: terminalBrightBlack,
      brightRed: terminalBrightRed,
      brightGreen: terminalBrightGreen,
      brightYellow: terminalBrightYellow,
      brightBlue: terminalBrightBlue,
      brightMagenta: terminalBrightMagenta,
      brightCyan: terminalBrightCyan,
      brightWhite: terminalBrightWhite,
    };
  }
  function tabsOf(id) {
    return ST.termTabs[id] || (ST.termTabs[id] = []);
  }
  function activeKey(id) {
    return ST.termActive[id];
  }
  function updateTermThemes() {
    Object.values(SESS).forEach((session) => {
      try {
        session.term.options.theme = xtermTheme();
      } catch (e) {}
    });
  }
  function setTermStatus() {
    const session = SESS[activeKey(ST.active)];
    const led = $("lt-term-led"),
      st = $("lt-term-stat-c");
    if (led) led.className = "lt-led" + (session && session.connected ? "" : " off");
    if (st) {
      let label;
      if (!session) label = "…";
      else if (session.connected) label = "connected";
      else label = "disconnected";
      st.textContent = label;
    }
  }
  function broadcastInput(data) {
    const encoded = _enc.encode(data);
    Object.values(SESS).forEach((session) => {
      if (session.ws.readyState === 1) session.ws.send(encoded);
    });
  }
  function renderTtabs(id) {
    const element = $("lt-ttabs");
    if (!element) return;
    const tabs = tabsOf(id);
    let html = "";
    tabs.forEach((k, i) => {
      const on = k === activeKey(id);
      html += `<span class="lt-ttab${on ? " on" : ""}" data-sess="${k}">sh${i + 1}${tabs.length > 1 ? ` <b data-close="${k}" role="button" tabindex="0" aria-label="Close shell ${i + 1}">${ph("x")}</b>` : ""}</span>`;
    });
    html += `<span class="lt-ttab add" data-newsess="1" role="button" tabindex="0" aria-label="New shell on this host" title="New shell on this host">${ph("plus")}</span>`;
    element.innerHTML = html;
  }
  function attachSession(key) {
    const session = SESS[key];
    if (!session) return;
    const mount = $("lt-term-mount");
    if (mount) {
      mount.innerHTML = "";
      mount.appendChild(session.wrap);
    }
    ST.termActive[session.host] = key;
    try {
      session.fit.fit();
    } catch (e) {}
    session.term.focus();
    renderTtabs(session.host);
    setTermStatus();
  }
  function createTerm() {
    const term = new Terminal({
      fontFamily:
        "'Symbols Nerd Font Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: TERMINAL_SCROLLBACK,
      theme: xtermTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    let search = null;
    if (window.SearchAddon) {
      search = new SearchAddon.SearchAddon();
      term.loadAddon(search);
    }
    if (window.Unicode11Addon) {
      try {
        term.loadAddon(new Unicode11Addon.Unicode11Addon());
        term.unicode.activeVersion = "11";
      } catch (e) {}
    }
    return { term, fit, search };
  }
  function openSession(id) {
    const mount = $("lt-term-mount");
    if (!mount) return;
    if (!window.Terminal || !window.FitAddon) {
      mount.innerHTML =
        '<div class="lt-empty"><b>Terminal needs xterm.js.</b><br>It loads from a CDN — check the internet connection.</div>';
      return;
    }
    const key = id + "#" + ++ST.sessSeq,
      server = byId[id];
    tabsOf(id).push(key);
    ST.termActive[id] = key;
    mount.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "lt-xterm";
    mount.appendChild(wrap);
    const { term, fit, search } = createTerm();
    term.open(wrap);
    try {
      fit.fit();
    } catch (e) {}
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(() => {
        try {
          fit.fit();
        } catch (e) {}
      });
    term.writeln("\x1b[90mConnecting to " + server.host + "…\x1b[0m");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/api/${id}/pty?cols=${term.cols}&rows=${term.rows}`,
    );
    ws.binaryType = "arraybuffer";
    const session = { key, host: id, term, fit, search, ws, wrap, connected: false };
    SESS[key] = session;
    ws.onopen = () => {
      session.connected = true;
      setTermStatus();
      try {
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      } catch (e) {}
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") term.write(ev.data);
      else term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      session.connected = false;
      term.write("\r\n\x1b[90m[session closed — Reconnect to restart]\x1b[0m\r\n");
      setTermStatus();
    };
    ws.onerror = () => {
      session.connected = false;
      setTermStatus();
    };
    term.onData((data) => {
      if (ST.broadcast) broadcastInput(data);
      else if (ws.readyState === 1) ws.send(_enc.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "r", c: cols, r: rows }));
    });
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.ctrlKey && (ev.key === "f" || ev.key === "F")) {
        if (ev.type === "keydown") toggleFind(true);
        return false;
      }
      return true;
    });
    wrap.addEventListener("dragover", (ev) => ev.preventDefault());
    wrap.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const file = ev.dataTransfer && ev.dataTransfer.files[0];
      if (file) injectFile(session, file);
    });
    if (window.ResizeObserver) {
      session.ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch (e) {}
      });
      session.ro.observe(wrap);
    }
    renderTtabs(id);
    setTermStatus();
    term.focus();
  }
  function closeSession(key, noReopen) {
    const session = SESS[key];
    if (!session) return;
    const id = session.host;
    try {
      session.ws.close();
    } catch (e) {}
    try {
      session.ro && session.ro.disconnect();
    } catch (e) {}
    try {
      session.term.dispose();
    } catch (e) {}
    try {
      session.wrap.remove();
    } catch (e) {}
    delete SESS[key];
    const arr = tabsOf(id).filter((k) => k !== key);
    ST.termTabs[id] = arr;
    if (ST.termActive[id] === key) ST.termActive[id] = arr[arr.length - 1] || null;
    if (noReopen) return;
    if (!arr.length) openSession(id);
    else attachSession(ST.termActive[id]);
  }
  function injectFile(session, file) {
    if (file.size > MAX_PASTE_BYTES) {
      toast(`Too big to paste (>${MAX_PASTE_BYTES / 1024} KB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (session.ws.readyState === 1) session.ws.send(_enc.encode(String(reader.result)));
      toast("Pasted “" + file.name + "” into the shell");
    };
    reader.readAsText(file);
  }
  function doFind(dir) {
    const session = SESS[activeKey(ST.active)];
    if (!session || !session.search) return;
    const query = ($("lt-find-in") || {}).value || "";
    if (!query) return;
    if (dir < 0) session.search.findPrevious(query);
    else session.search.findNext(query);
  }
  function toggleFind(show) {
    const findEl = $("lt-find");
    if (!findEl) return;
    const vis = show === undefined ? findEl.hidden : show;
    findEl.hidden = !vis;
    if (vis) {
      const input = $("lt-find-in");
      if (input) input.focus();
    } else {
      const session = SESS[activeKey(ST.active)];
      if (session) session.term.focus();
    }
  }
  function viewTerminal() {
    const id = ST.active,
      server = byId[id];
    const view = $("lt-view");
    view.className = "lt-view flexcol";
    view.innerHTML = `<div class="lt-term${ST.broadcast ? " bcast" : ""}"><div class="lt-term-bar"><span class="lt-led off" id="lt-term-led"></span><span>${server.kind === "wsl" ? "wsl.exe" : "ssh"} · ${esc(server.host)}${server.kind === "ssh" ? ":" + server.port : ""}</span><span id="lt-term-stat-c">…</span><span class="lt-ttabs" id="lt-ttabs"></span><span class="lt-grow"></span><span class="lt-tbtn${ST.broadcast ? " on" : ""}" data-tact="broadcast" title="Mirror keystrokes to every open session">${ph("broadcast")}Broadcast</span><span class="lt-tbtn" data-tact="find" title="Search scrollback (Ctrl+F)">${ph("magnifying-glass")}Find</span><span class="lt-tbtn" data-tact="clear">${ph("eraser")}Clear</span><span class="lt-tbtn" data-tact="reconnect">${ph("arrow-clockwise")}Reconnect</span></div><div class="lt-find" id="lt-find" hidden><input id="lt-find-in" placeholder="search scrollback — Enter / Shift+Enter" autocomplete="off"><span class="lt-tbtn lt-icon-control" data-tact="find-prev" role="button" tabindex="0" aria-label="Previous match">${ph("caret-up")}</span><span class="lt-tbtn lt-icon-control" data-tact="find-next" role="button" tabindex="0" aria-label="Next match">${ph("caret-down")}</span><span class="lt-tbtn lt-icon-control" data-tact="find-close" role="button" tabindex="0" aria-label="Close search">${ph("x")}</span></div><div class="lt-term-mount" id="lt-term-mount"></div></div>`;
    const key = activeKey(id);
    if (key && SESS[key]) attachSession(key);
    else openSession(id);
  }

  /* ---------------- monitor (availability · trends · processes · vitals) ---------------- */
  function monitorAnnouncementRegion() {
    let region = $("lt-monitor-announcement");
    if (!region) {
      region = document.createElement("div");
      region.id = "lt-monitor-announcement";
      region.className = "lt-sr-only";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      (document.querySelector(".lt-window") || document.body).appendChild(region);
    }
    return region;
  }
  function renderedMonitorSectionIds() {
    return [...document.querySelectorAll("#lt-view [data-monitor-section]")].map((section) =>
      section.getAttribute("data-monitor-section"),
    );
  }
  function moveMonitorSection(sectionId, targetId, placeAfter) {
    if (sectionId === targetId) return false;
    const order = ST.monitorOrder.slice(),
      sourceIndex = order.indexOf(sectionId);
    if (sourceIndex < 0 || order.indexOf(targetId) < 0) return false;
    order.splice(sourceIndex, 1);
    const targetIndex = order.indexOf(targetId);
    order.splice(targetIndex + (placeAfter ? 1 : 0), 0, sectionId);
    if (order.every((value, index) => value === ST.monitorOrder[index])) return false;
    ST.monitorOrder = order;
    return true;
  }
  function monitorSectionHtml(sectionId, section, position, total) {
    const label = MONITOR_SECTION_LABELS[sectionId],
      headingClass = section.headingClass ? " " + section.headingClass : "",
      handleLabel = `${label}, position ${position} of ${total}. Alt plus Up or Down Arrow moves this section.`;
    return (
      `<section class="lt-monitor-section" data-monitor-section="${sectionId}">` +
      `<div class="lt-mhd${headingClass}">` +
      `<button type="button" class="lt-monitor-drag-handle" draggable="true" data-monitor-drag-handle="${sectionId}" aria-label="${handleLabel}" title="Drag to reorder · Alt+Arrow to move">` +
      ph("dots-six-vertical") +
      `</button>` +
      `<b>${label}</b>` +
      `<span class="ln"></span>` +
      (section.headingExtra || "") +
      `</div>` +
      section.body +
      `</section>`
    );
  }
  function processState(id) {
    if (!ST.process[id]) {
      const status = FLEET[id];
      ST.process[id] = {
        scope: "mine",
        rows: status && Array.isArray(status.top_procs) ? status.top_procs : [],
        loadedScope: "mine",
        loading: false,
        error: null,
        scopeRevision: 0,
        nextRequestId: 0,
        appliedRequestId: 0,
        inFlightRevision: null,
      };
    }
    return ST.process[id];
  }
  function syncMineProcessRows(id, status) {
    const state = ST.process[id];
    if (!state || state.scope !== "mine" || state.loading) return;
    state.rows = status && Array.isArray(status.top_procs) ? status.top_procs : [];
    state.loadedScope = "mine";
    state.error = null;
  }
  function refreshMonitorStatus(id, showLoading) {
    const server = byId[id];
    if (!server || server.kind === "nas") return;
    const state = processState(id),
      scope = state.scope,
      scopeRevision = state.scopeRevision;
    if (!showLoading && state.inFlightRevision === scopeRevision) return;
    const requestId = ++state.nextRequestId;
    state.inFlightRevision = scopeRevision;
    if (showLoading) {
      state.rows = [];
      state.loadedScope = null;
      state.loading = true;
      state.error = null;
      if (ST.view === "server" && ST.tab === "monitor" && ST.active === id) viewMonitor();
    }
    api("/api/" + id + "/status?process_scope=" + encodeURIComponent(scope))
      .then((status) => {
        if (
          state.scopeRevision !== scopeRevision ||
          state.scope !== scope ||
          requestId <= state.appliedRequestId
        )
          return;
        state.appliedRequestId = requestId;
        FLEET[id] = status;
        state.rows = Array.isArray(status.top_procs) ? status.top_procs : [];
        state.loadedScope = scope;
        state.loading = false;
        state.error = null;
        pushHist(id);
        updateNetwork(id, status);
        if (ST.view === "server" && ST.tab === "monitor" && ST.active === id) viewMonitor();
      })
      .catch((error) => {
        if (
          state.scopeRevision !== scopeRevision ||
          state.scope !== scope ||
          requestId <= state.appliedRequestId
        )
          return;
        state.appliedRequestId = requestId;
        state.rows = [];
        state.loadedScope = null;
        state.loading = false;
        state.error = error && error.message ? error.message : "Status refresh failed";
        resetNetwork(id);
        if (ST.view === "server" && ST.tab === "monitor" && ST.active === id) viewMonitor();
      })
      .finally(() => {
        if (state.inFlightRevision === scopeRevision) state.inFlightRevision = null;
      });
  }
  function selectProcessScope(scope) {
    const id = ST.active,
      server = byId[id];
    if (!server || server.kind === "nas" || !PROCESS_SCOPE_LABELS[scope]) return;
    const state = processState(id);
    if (state.scope === scope) return;
    state.scope = scope;
    state.scopeRevision++;
    refreshMonitorStatus(id, true);
  }
  function temperatureTone(temp) {
    if (temp < 60) return "online";
    if (temp < 75) return "busy";
    if (temp < 85) return "warning";
    return "destructive";
  }
  function pushHist(id) {
    const fleet = FLEET[id];
    if (!fleet || !fleet.gpus) return;
    fleet.gpus.forEach((gpu, i) => {
      const key = id + ":" + gpuIndex(gpu, i);
      const samples = ST.hist[key] || (ST.hist[key] = []);
      samples.push({ u: gpu.util, m: pct(gpu.mu, gpu.mt) });
      if (samples.length > GPU_HISTORY_SAMPLES) samples.shift();
    });
  }
  function resetNetwork(id, sample) {
    ST.network[id] = { sample: sample || null, rate: null, rx: [], tx: [] };
  }
  function updateNetwork(id, fleet) {
    const network = fleet && fleet.network;
    if (
      !network ||
      network.available !== true ||
      !Number.isSafeInteger(network.rx_bytes) ||
      !Number.isSafeInteger(network.tx_bytes) ||
      !Number.isSafeInteger(network.uptime_seconds) ||
      network.rx_bytes < 0 ||
      network.tx_bytes < 0 ||
      network.uptime_seconds < 0
    ) {
      resetNetwork(id);
      return;
    }
    const current = {
      rx: network.rx_bytes,
      tx: network.tx_bytes,
      uptime: network.uptime_seconds,
    };
    const state = ST.network[id];
    if (!state || !state.sample) {
      resetNetwork(id, current);
      return;
    }
    const elapsed = current.uptime - state.sample.uptime;
    if (
      !Number.isFinite(elapsed) ||
      elapsed <= 0 ||
      current.rx < state.sample.rx ||
      current.tx < state.sample.tx
    ) {
      resetNetwork(id, current);
      return;
    }
    const rx = (current.rx - state.sample.rx) / elapsed,
      tx = (current.tx - state.sample.tx) / elapsed;
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) {
      resetNetwork(id, current);
      return;
    }
    state.sample = current;
    state.rate = { rx, tx };
    state.rx.push(rx);
    state.tx.push(tx);
    if (state.rx.length > NETWORK_HISTORY_SAMPLES) state.rx.shift();
    if (state.tx.length > NETWORK_HISTORY_SAMPLES) state.tx.shift();
  }
  function networkSparkline(points, tone) {
    if (!points.length) return '<div class="lt-net-pending">Collecting trend…</div>';
    const W = 100,
      H = 28,
      max = Math.max(1, ...points),
      line =
        points.length < 2
          ? `0,${((1 - points[0] / max) * H).toFixed(2)} ${W},${((1 - points[0] / max) * H).toFixed(2)}`
          : points
              .map(
                (value, index) =>
                  `${((index / (points.length - 1)) * W).toFixed(2)},${((1 - value / max) * H).toFixed(2)}`,
              )
              .join(" ");
    return `<svg class="lt-net-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon class="${tone}" points="${line} ${W},${H} 0,${H}"></polygon><polyline class="${tone}" points="${line}"></polyline></svg>`;
  }
  function lineChart(series, danger, metric) {
    const W = 100,
      H = 40;
    let svg = "";
    [0, 50, 100].forEach((val) => {
      const y = (1 - val / 100) * H;
      svg += `<line class="gl" x1="0" y1="${y}" x2="${W}" y2="${y}"></line>`;
    });
    if (danger != null) {
      const y = (1 - danger / 100) * H;
      svg += `<line class="dgr" x1="0" y1="${y}" x2="${W}" y2="${y}"></line>`;
    }
    series.forEach((entry) => {
      const pts = entry.pts;
      if (!pts.length) return;
      const n = pts.length;
      const line =
        n < 2
          ? `0,${((1 - (pts[0] || 0) / 100) * H).toFixed(1)} ${W},${((1 - (pts[0] || 0) / 100) * H).toFixed(1)}`
          : pts
              .map(
                (val, i) => `${((i / (n - 1)) * W).toFixed(2)},${((1 - val / 100) * H).toFixed(2)}`,
              )
              .join(" ");
      svg += `<polygon class="${entry.tone}" points="${line} ${W},${H} 0,${H}"></polygon><polyline class="${entry.tone}" points="${line}"></polyline>`;
    });
    const labs = series
      .map((entry) => {
        const lv = entry.pts.length ? entry.pts[entry.pts.length - 1] : 0,
          top = (1 - lv / 100) * 100;
        return `<span class="lt-lc-dot ${entry.tone}" style="top:${top}%"></span><span class="lt-lc-lab ${entry.tone}" style="top:${top}%">${esc(entry.label)} ${Math.round(lv)}%</span>`;
      })
      .join("");
    return `<div class="lt-chart" data-metric="${metric || ""}"><div class="lt-chart-ax"><span>100</span><span>50</span><span>0</span></div><svg class="lt-lc" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg>${labs}</div>`;
  }
  function viewMonitor() {
    const id = ST.active,
      server = byId[id],
      fleet = FLEET[id];
    const view = $("lt-view");
    if (ST.monitorDrag) {
      ST.monitorRenderPending = true;
      return;
    }
    const focusedScopeControl =
      document.activeElement && document.activeElement.closest
        ? document.activeElement.closest("[data-process-scope]")
        : null;
    const focusedScope = focusedScopeControl
      ? focusedScopeControl.getAttribute("data-process-scope")
      : null;
    const focusedHandleControl =
      document.activeElement && document.activeElement.closest
        ? document.activeElement.closest("[data-monitor-drag-handle]")
        : null;
    const focusedHandle =
      ST.monitorFocusSection ||
      (focusedHandleControl
        ? focusedHandleControl.getAttribute("data-monitor-drag-handle")
        : null);
    ST.monitorFocusSection = null;
    view.className = "lt-view pad";
    if (!fleet) {
      view.innerHTML = '<div class="lt-empty">Connecting…</div>';
      return;
    }
    if (fleet.online === false) {
      view.innerHTML = `<div class="lt-empty"><b>${esc(server.name)} is offline.</b><br>${esc(fleet.error || "")}</div>`;
      return;
    }
    const gpuList = gpus(fleet),
      diskList = disks(fleet),
      GB = (m) => m / 1024;
    const bar = (p, tone, extra) =>
      `<span class="lt-bar"><span class="lt-fill ${tone.startsWith("lt-chart-") ? tone : "lt-tone-" + tone}" style="width:${clampPct(p)}%"></span>${extra || ""}</span>`;
    const sections = {};
    let html = '<div class="lt-mon">';
    /* availability strip — free VRAM is the hero */
    if (gpuList.length) {
      const free = gpuList.filter((gpu) => gpu.util < 10 && pct(gpu.mu, gpu.mt) < 10).length;
      let body = '<div class="lt-avail">';
      gpuList.forEach((gpu, i) => {
        const ix = gpuIndex(gpu, i),
          mp = pct(gpu.mu, gpu.mt),
          fGB = GB(gpu.mt - gpu.mu),
          isFree = gpu.util < 10 && mp < 10,
          memoryTone = utilizationTone(mp);
        body +=
          `<div class="lt-av${isFree ? " free" : ""}"><div class="lt-av-top"><span class="lt-av-ix ${chartTone(ix)}">GPU ${ix}</span><span class="lt-av-model">${esc(gpu.name)}</span><span class="lt-av-t lt-tone-${temperatureTone(gpu.temp)}">${gpu.temp}°C</span></div>` +
          `<div class="lt-av-free"><b class="lt-tone-${isFree ? "online" : memoryTone}">${fGB.toFixed(1)}</b><span>GB free</span>${isFree ? '<span class="lt-av-pill">FREE</span>' : `<em>${gpu.util}% util</em>`}</div>` +
          bar(
            mp,
            memoryTone,
            `<span class="lt-av-mark" style="left:${clampPct(gpu.util)}%"></span>`,
          ) +
          `<div class="lt-av-sub"><span>${GB(gpu.mu).toFixed(1)} / ${GB(gpu.mt).toFixed(0)} GB</span><span>${Math.round(gpu.pow)}/${gpu.plim} W</span></div></div>`;
      });
      body += "</div>";
      sections.gpus = {
        headingExtra: `<span class="cnt">${free}/${gpuList.length} free</span>`,
        body,
      };
    } else if (server.kind !== "nas") {
      sections.gpus = {
        body: `<div class="lt-note">No GPU on this host — CPU server · ${fleet.ncpu || "?"} cores · load ${fleet.load ? fleet.load[0] : "?"}</div>`,
      };
    }
    /* aggregate network throughput */
    if (server.kind !== "nas") {
      const networkAvailable = fleet.network && fleet.network.available === true,
        network = networkAvailable
          ? ST.network[id] || { rate: null, rx: [], tx: [] }
          : { rate: null, rx: [], tx: [] },
        collecting = networkAvailable && !network.rate,
        span = Math.max(network.rx.length, network.tx.length),
        spanLabel = !networkAvailable ? "unavailable" : span < 2 ? "collecting" : `${span} samples`,
        receiveLabel = !networkAvailable
          ? "Unavailable"
          : collecting
            ? "Collecting…"
            : bytes(network.rate.rx) + "/s",
        transmitLabel = !networkAvailable
          ? "Unavailable"
          : collecting
            ? "Collecting…"
            : bytes(network.rate.tx) + "/s";
      sections.network = {
        headingExtra: `<span class="cnt">${spanLabel}</span>`,
        body:
          `<div class="lt-network">` +
          `<div class="lt-net-card"><div class="lt-net-top"><span>Receive</span><b class="${network.rate ? "lt-chart-tone-1" : "lt-tone-muted"}">${receiveLabel}</b></div>${networkSparkline(network.rx, "lt-chart-tone-1")}</div>` +
          `<div class="lt-net-card"><div class="lt-net-top"><span>Transmit</span><b class="${network.rate ? "lt-chart-tone-2" : "lt-tone-muted"}">${transmitLabel}</b></div>${networkSparkline(network.tx, "lt-chart-tone-2")}</div></div>`,
      };
    }
    /* general processes */
    if (server.kind !== "nas") {
      const process = processState(id),
        scopeLabel = PROCESS_SCOPE_LABELS[process.scope],
        rowLimit = process.scope === "mine" ? 20 : 50,
        topProcs =
          process.loadedScope === process.scope ? process.rows.slice(0, rowLimit) : [],
        scopeControls = Object.entries(PROCESS_SCOPE_LABELS)
          .map(
            ([scope, label]) =>
              `<button type="button" class="lt-proc-scope${process.scope === scope ? " on" : ""}" data-process-scope="${scope}" aria-pressed="${process.scope === scope}" aria-label="Show ${label} processes">${label}</button>`,
          )
          .join(""),
        countLabel = process.loading
          ? "Loading"
          : process.error
            ? "Error"
            : `${scopeLabel} · ${topProcs.length}`;
      let body = `<div class="lt-panel"><div class="lt-proc-h lt-top-proc-h"><span>USER</span><span>PID</span><span>CPU</span><span>MEM</span><span>RSS</span><span>TIME</span><span>COMMAND</span></div>`;
      if (process.loading) {
        body += `<div class="lt-proc-empty" role="status" aria-live="polite">Loading ${scopeLabel} processes…</div>`;
      } else if (process.error) {
        body += `<div class="lt-proc-empty lt-proc-error" role="alert">Could not load ${scopeLabel} processes. ${esc(process.error)}</div>`;
      } else if (topProcs.length) {
        topProcs.forEach((proc, procIndex) => {
          const procKey = "top:" + process.scope + ":" + proc.pid,
            cpuPct = Number(proc.cpu_pct),
            memoryPct = Number(proc.memory_pct);
          body +=
            `<div class="lt-proc lt-top-proc${process.scope === "mine" ? " me" : ""}${ST.procOpen[procKey] ? " open" : ""}" data-proc-key="${procKey}"><span class="lt-proc-u"><i class="${chartTone(procIndex)}"></i>${esc(proc.user)}</span><span class="lt-proc-pid">${proc.pid}</span><span class="lt-proc-cpu">${Number.isFinite(cpuPct) ? cpuPct.toFixed(1) + "%" : "—"}</span><span class="lt-proc-pct">${Number.isFinite(memoryPct) ? memoryPct.toFixed(1) + "%" : "—"}</span><span class="lt-proc-rss">${bytes(proc.resident_bytes) || "—"}</span><span class="lt-proc-time">${esc(proc.elapsed || "")}</span><span class="lt-proc-cmd" title="${esc(proc.command || "")}">${esc(proc.command || "")}</span></div>` +
            (ST.procOpen[procKey]
              ? `<div class="lt-proc-full">${esc(proc.command || "")}</div>`
              : "");
        });
      } else {
        const emptyMessage =
          process.scope === "mine"
            ? "No processes owned by your remote account."
            : process.scope === "others"
              ? "No processes owned by other non-root accounts."
              : "No root-owned processes.";
        body += `<div class="lt-proc-empty">${emptyMessage}</div>`;
      }
      body += "</div>";
      sections["top-processes"] = {
        headingClass: "lt-process-heading",
        headingExtra: `<div class="lt-proc-scopes" role="group" aria-label="Process owner scope">${scopeControls}</div><span class="cnt">${countLabel}</span>`,
        body,
      };
    }
    /* GPU processes */
    if (server.kind !== "nas") {
      const procs = (fleet.procs || []).slice().sort((a, b) => (b.mem || 0) - (a.mem || 0));
      let body = `<div class="lt-panel"><div class="lt-proc-h"><span>USER</span><span>PID</span><span>GPU</span><span>VRAM</span><span>TIME</span><span>COMMAND</span></div>`;
      if (procs.length)
        procs.forEach((proc, procIndex) => {
          const procKey = "gpu:" + proc.pid;
          body +=
            `<div class="lt-proc${proc.user === server.user ? " me" : ""}${ST.procOpen[procKey] ? " open" : ""}" data-proc-key="${procKey}"><span class="lt-proc-u"><i class="${chartTone(procIndex)}"></i>${esc(proc.user)}</span><span class="lt-proc-pid">${proc.pid}</span><span class="lt-proc-gpu">${proc.gpu}</span><span class="lt-proc-mem">${GB(proc.mem).toFixed(1)} GB</span><span class="lt-proc-time">${esc(proc.etime || "")}</span><span class="lt-proc-cmd" title="${esc(proc.cmd || "")}">${esc(proc.cmd || "")}</span></div>` +
            (ST.procOpen[procKey] ? `<div class="lt-proc-full">${esc(proc.cmd || "")}</div>` : "");
        });
      else
        body += `<div class="lt-proc-empty">No GPU processes${gpuList.length ? " — GPUs idle, or other users’ jobs not visible" : ""}.</div>`;
      body += "</div>";
      sections["gpu-processes"] = {
        headingExtra: `<span class="cnt">${procs.length}</span>`,
        body,
      };
    }
    /* host vitals (bullet bars) */
    const bl = (label, val, p, c, sub) =>
      `<div class="lt-bl"><div class="lt-bl-top"><span>${esc(label)}</span><span>${val}</span></div>${bar(p, c)}${sub ? `<div class="lt-bl-sub">${sub}</div>` : ""}</div>`;
    let vitals = "";
    if (server.kind !== "nas") {
      const lp = fleet.ncpu ? Math.min(100, (fleet.load[0] / fleet.ncpu) * 100) : 0;
      vitals += bl(
        "CPU load",
        `${fleet.load ? fleet.load[0] : "—"} / ${fleet.ncpu || "?"}`,
        lp,
        utilizationTone(lp),
        `${Math.round(lp)}% of ${fleet.ncpu || "?"} cores`,
      );
      if (fleet.mem) {
        const mp = pct(fleet.mem.used, fleet.mem.total);
        vitals += bl(
          "System RAM",
          `${bytes(fleet.mem.used)} / ${bytes(fleet.mem.total)}`,
          mp,
          "lt-chart-tone-2",
          mp + "% used",
        );
      }
    }
    diskList.forEach((disk) => {
      const p = pct(disk.used, disk.size);
      vitals += bl(
        disk.m,
        `${bytes(disk.used)} / ${bytes(disk.size)}`,
        p,
        utilizationTone(p),
        `${bytes(disk.size - disk.used)} free · ${p}%`,
      );
    });
    let uptimeLabel = "";
    if (server.kind === "nas") uptimeLabel = "volume";
    else if (fleet.up) uptimeLabel = "up " + fleet.up;
    const hostBody = `<div class="lt-vitals">${vitals || '<div class="lt-proc-empty">No vitals reported.</div>'}</div>`;
    if (server.kind === "nas") {
      html += `<div class="lt-mhd"><b>Host · storage</b><span class="ln"></span><span class="cnt">${uptimeLabel}</span></div>${hostBody}`;
    } else {
      sections.host = {
        headingExtra: `<span class="cnt">${uptimeLabel}</span>`,
        body: hostBody,
      };
    }
    /* trends (history) at the bottom */
    if (gpuList.length) {
      const mk = (which) =>
        gpuList.map((gpu, i) => {
          const ix = gpuIndex(gpu, i),
            samples = ST.hist[id + ":" + ix] || [{ u: gpu.util, m: pct(gpu.mu, gpu.mt) }];
          return {
            label: "GPU" + ix,
            tone: chartTone(ix),
            pts: samples.map((sample) => sample[which]),
          };
        });
      const utilSeries = mk("u"),
        vramSeries = mk("m");
      ST.chart = { u: { series: utilSeries, sec: 2 }, m: { series: vramSeries, sec: 2 } };
      const span = Math.max(
        1,
        ...gpuList.map((gpu, i) => {
          const ix = gpuIndex(gpu, i);
          return (ST.hist[id + ":" + ix] || []).length;
        }),
      );
      const mins = Math.round(((span * 2) / 60) * 10) / 10;
      sections.utilization = {
        headingExtra: `<span class="cnt">% · last ${span < 2 ? "now" : mins + " min"}</span>`,
        body: lineChart(utilSeries, null, "u"),
      };
      sections.vram = {
        headingExtra: '<span class="cnt">% of total · 90% danger</span>',
        body: lineChart(vramSeries, 90, "m"),
      };
    }
    if (server.kind !== "nas") {
      const renderedOrder = ST.monitorOrder.filter((sectionId) => sections[sectionId]);
      html += renderedOrder
        .map((sectionId, index) =>
          monitorSectionHtml(sectionId, sections[sectionId], index + 1, renderedOrder.length),
        )
        .join("");
    }
    html += "</div>";
    view.innerHTML = html;
    if (focusedHandle) {
      const handle = view.querySelector(`[data-monitor-drag-handle="${focusedHandle}"]`);
      if (handle) handle.focus();
    } else if (focusedScope) {
      const control = view.querySelector(`[data-process-scope="${focusedScope}"]`);
      if (control) control.focus();
    }
  }

  /* ---------------- dispatch ---------------- */
  function stopMon() {
    if (ST.monTimer) {
      clearInterval(ST.monTimer);
      ST.monTimer = null;
    }
  }
  function startMon() {
    const server = byId[ST.active];
    if (!server || server.kind === "nas") return;
    ST.monTimer = setInterval(() => {
      const cur = ST.active;
      refreshMonitorStatus(cur, false);
    }, MONITOR_POLL_MS);
  }
  function renderView() {
    stopMon();
    if (ST.view === "fleet") {
      viewFleet();
      return;
    }
    const server = byId[ST.active];
    const valid = tabsFor(server).map((t) => t[0]);
    if (!valid.includes(ST.tab)) ST.tab = "explorer";
    if (ST.tab === "explorer") viewExplorer();
    else if (ST.tab === "terminal") viewTerminal();
    else {
      resetNetwork(ST.active);
      updateNetwork(ST.active, FLEET[ST.active]);
      viewMonitor();
      startMon();
    }
  }
  function clearMonitorDropIndicator() {
    document
      .querySelectorAll("#lt-view .lt-monitor-drop-before, #lt-view .lt-monitor-drop-after")
      .forEach((section) =>
        section.classList.remove("lt-monitor-drop-before", "lt-monitor-drop-after"),
      );
  }
  function visibleMonitorOrder(renderedIds) {
    const rendered = new Set(renderedIds);
    return ST.monitorOrder.filter((sectionId) => rendered.has(sectionId));
  }
  function announceMonitorMove(sectionId, renderedIds) {
    const order = visibleMonitorOrder(renderedIds),
      position = order.indexOf(sectionId) + 1;
    monitorAnnouncementRegion().textContent =
      `${MONITOR_SECTION_LABELS[sectionId]} moved to position ${position} of ${order.length}.`;
  }
  function finishMonitorDrag() {
    if (!ST.monitorDrag) return;
    const shouldRender = ST.monitorRenderPending || ST.monitorDrag.orderChanged;
    const dragged = document.querySelector("#lt-view .lt-monitor-section.lt-monitor-dragging");
    if (dragged) dragged.classList.remove("lt-monitor-dragging");
    clearMonitorDropIndicator();
    ST.monitorDrag = null;
    ST.monitorRenderPending = false;
    if (shouldRender && ST.view === "server" && ST.tab === "monitor") viewMonitor();
  }
  document.addEventListener("dragstart", (event) => {
    const handle = event.target.closest && event.target.closest("[data-monitor-drag-handle]");
    if (!handle) return;
    const sectionId = handle.getAttribute("data-monitor-drag-handle"),
      section = handle.closest("[data-monitor-section]");
    if (!section || section.getAttribute("data-monitor-section") !== sectionId) return;
    ST.monitorDrag = { sectionId, targetId: null, placeAfter: false };
    section.classList.add("lt-monitor-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-lab-terminus-monitor-section", sectionId);
  });
  document.addEventListener("dragover", (event) => {
    if (!ST.monitorDrag) return;
    const section = event.target.closest && event.target.closest("[data-monitor-section]");
    clearMonitorDropIndicator();
    ST.monitorDrag.targetId = null;
    if (!section) return;
    const targetId = section.getAttribute("data-monitor-section");
    if (targetId === ST.monitorDrag.sectionId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = section.getBoundingClientRect(),
      placeAfter = event.clientY >= rect.top + rect.height / 2;
    section.classList.add(placeAfter ? "lt-monitor-drop-after" : "lt-monitor-drop-before");
    ST.monitorDrag.targetId = targetId;
    ST.monitorDrag.placeAfter = placeAfter;
  });
  document.addEventListener("drop", (event) => {
    if (!ST.monitorDrag) return;
    const section = event.target.closest && event.target.closest("[data-monitor-section]"),
      targetId = section && section.getAttribute("data-monitor-section"),
      renderedIds = renderedMonitorSectionIds();
    if (targetId && targetId === ST.monitorDrag.targetId) {
      event.preventDefault();
      if (moveMonitorSection(ST.monitorDrag.sectionId, targetId, ST.monitorDrag.placeAfter)) {
        ST.monitorDrag.orderChanged = true;
        announceMonitorMove(ST.monitorDrag.sectionId, renderedIds);
      }
    }
    finishMonitorDrag();
  });
  document.addEventListener("dragend", finishMonitorDrag);
  /* chart hover tooltip */
  function ensureChartTip() {
    const windowEl = document.querySelector(".lt-window") || document.body;
    let tip = $("lt-cht-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "lt-cht-tip";
      windowEl.appendChild(tip);
    }
    let guide = $("lt-cht-guide");
    if (!guide) {
      guide = document.createElement("div");
      guide.id = "lt-cht-guide";
      windowEl.appendChild(guide);
    }
    return { t: tip, g: guide };
  }
  function hideChartTip() {
    const tip = $("lt-cht-tip"),
      guide = $("lt-cht-guide");
    if (tip) tip.style.display = "none";
    if (guide) guide.style.display = "none";
  }
  document.addEventListener("mousemove", (e) => {
    const chartEl = e.target.closest(".lt-chart");
    if (!chartEl || !ST.chart) {
      hideChartTip();
      return;
    }
    const data = ST.chart[chartEl.getAttribute("data-metric")];
    if (!data) {
      hideChartTip();
      return;
    }
    const rect = chartEl.getBoundingClientRect(),
      L = 34,
      R = 14,
      plotWidth = rect.width - L - R,
      fracX = (e.clientX - rect.left - L) / plotWidth;
    if (fracX < -0.03 || fracX > 1.03) {
      hideChartTip();
      return;
    }
    const series = data.series,
      n = Math.max(1, ...series.map((s) => s.pts.length)),
      idx = Math.min(n - 1, Math.max(0, Math.round(Math.min(1, Math.max(0, fracX)) * (n - 1))));
    const px = rect.left + L + (n < 2 ? plotWidth : (idx / (n - 1)) * plotWidth);
    const { t: tip, g: guide } = ensureChartTip();
    guide.style.display = "block";
    guide.style.left = px + "px";
    guide.style.top = rect.top + "px";
    guide.style.height = rect.height + "px";
    const agoSec = (n - 1 - idx) * data.sec;
    tip.innerHTML =
      `<div class="tt">${agoSec <= 0 ? "now" : "~" + agoSec + "s ago"}</div>` +
      series
        .map((s) => {
          const v = s.pts[Math.min(idx, s.pts.length - 1)] || 0;
          return `<div><span class="${s.tone}">●</span> ${esc(s.label)} <b>${Math.round(v)}%</b></div>`;
        })
        .join("");
    tip.style.display = "block";
    const tipWidth = tip.offsetWidth;
    let tipX = px + 12;
    if (tipX + tipWidth > window.innerWidth - 8) tipX = px - tipWidth - 12;
    tip.style.left = tipX + "px";
    tip.style.top = rect.top + 6 + "px";
  });
  function renderAll() {
    renderSide();
    renderHeadTabs();
    renderView();
  }
  function openServer(id, tab) {
    ST.view = "server";
    ST.active = id;
    if (tab) ST.tab = tab;
    ST.sel = null;
    ST.filter = "";
    ST.listing = null;
    const server = byId[id];
    if (server && server.group) {
      ST.collapsed[server.group] = false;
    }
    renderAll();
  }

  /* ---------------- events ---------------- */
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".lt-window") && !e.target.closest(".lt-toast")) return;
    if (e.target.closest("[data-view]")) {
      ST.view = "fleet";
      renderAll();
      return;
    }
    if (e.target.id === "lt-modal") {
      closeModal();
      return;
    }
    if (e.target.id === "lt-sendto") {
      closeSendTo();
      return;
    }
    if (e.target.closest("[data-sclose]")) {
      closeSendTo();
      return;
    }
    if (e.target.closest("[data-ssubmit]")) {
      submitSendTo();
      return;
    }
    if (e.target.closest("#lt-xfer-btn")) {
      toggleDrawer();
      return;
    }
    if (e.target.closest("[data-xclose]")) {
      toggleDrawer(false);
      return;
    }
    {
      const xc = e.target.closest("[data-xcancel]");
      if (xc) {
        api("/api/transfers/" + xc.getAttribute("data-xcancel") + "/cancel", {
          method: "POST",
        }).then(xferTick);
        return;
      }
    }
    if (e.target.closest('[data-xfer="clear"]')) {
      api("/api/transfers/clear", { method: "POST" }).then(xferTick);
      return;
    }
    if (e.target.closest("[data-mclose]")) {
      closeModal();
      return;
    }
    if (e.target.closest("[data-msubmit]")) {
      submitAdd();
      return;
    }
    const mmode = e.target.closest("[data-mode]");
    if (mmode) {
      _modal.mode = mmode.getAttribute("data-mode");
      renderModal();
      return;
    }
    /* folder/server edit + remove are via right-click — see the contextmenu listener */
    const addb = e.target.closest("[data-add]");
    if (addb) {
      openAddModal(addb.getAttribute("data-add") || "server", addb.getAttribute("data-folder"));
      return;
    }
    const grp = e.target.closest("[data-grp]");
    if (grp) {
      const k = grp.getAttribute("data-grp");
      ST.collapsed[k] = !folderCollapsed(k);
      try {
        localStorage.setItem("lt-collapsed", JSON.stringify(ST.collapsed));
      } catch (e) {}
      renderSide();
      return;
    }
    const ovb = e.target.closest("[data-ov]");
    if (ovb) {
      ST.ovmode = ovb.getAttribute("data-ov");
      try {
        localStorage.setItem("lt-ovmode", ST.ovmode);
      } catch (e) {}
      viewFleet();
      return;
    }
    const groupControl = e.target.closest("[data-ov-group-control]");
    if (groupControl) {
      const group = groupControl.getAttribute("data-ov-group");
      if (group === null || FOLDERS.some((folder) => folder.key === group)) {
        ST.ovgroup = group;
        viewFleet();
      }
      return;
    }
    const closeb = e.target.closest("[data-close]");
    if (closeb) {
      closeSession(closeb.getAttribute("data-close"));
      return;
    }
    const sesst = e.target.closest("[data-sess]");
    if (sesst) {
      attachSession(sesst.getAttribute("data-sess"));
      return;
    }
    if (e.target.closest("[data-newsess]")) {
      openSession(ST.active);
      return;
    }
    const tact = e.target.closest("[data-tact]");
    if (tact) {
      const action = tact.getAttribute("data-tact"),
        id = ST.active,
        key = activeKey(id),
        sess = SESS[key];
      if (action === "clear") {
        if (sess) sess.term.clear();
      } else if (action === "reconnect") {
        if (key) closeSession(key, true);
        openSession(id);
      } else if (action === "broadcast") {
        ST.broadcast = !ST.broadcast;
        tact.classList.toggle("on", ST.broadcast);
        const termEl = document.querySelector(".lt-term");
        if (termEl) termEl.classList.toggle("bcast", ST.broadcast);
        toast(ST.broadcast ? "Broadcast ON — keystrokes go to ALL open sessions" : "Broadcast off");
      } else if (action === "find") {
        toggleFind();
      } else if (action === "find-next") {
        doFind(1);
      } else if (action === "find-prev") {
        doFind(-1);
      } else if (action === "find-close") {
        toggleFind(false);
      }
      return;
    }
    const card = e.target.closest("#lt-view [data-sv]");
    if (card) {
      openServer(card.getAttribute("data-sv"), "explorer");
      return;
    }
    const sv = e.target.closest(".lt-side [data-sv]");
    if (sv) {
      openServer(sv.getAttribute("data-sv"));
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      ST.tab = tab.getAttribute("data-tab");
      ST.sel = null;
      renderHeadTabs();
      renderView();
      return;
    }
    const processScope = e.target.closest("[data-process-scope]");
    if (processScope) {
      selectProcessScope(processScope.getAttribute("data-process-scope"));
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      ST.filter = "";
      enterDir(ST.active, go.getAttribute("data-go"));
      return;
    }
    const sort = e.target.closest("[data-sort]");
    if (sort) {
      const k = sort.getAttribute("data-sort");
      if (ST.sort.key === k) ST.sort.asc = !ST.sort.asc;
      else {
        ST.sort.key = k;
        ST.sort.asc = true;
      }
      renderExplorer();
      return;
    }
    const row = e.target.closest(".lt-fr");
    if (row) {
      const name = row.getAttribute("data-name"),
        dir = row.getAttribute("data-dir") === "1";
      if (dir) {
        ST.filter = "";
        enterDir(ST.active, joinp(ST.cwd[ST.active], name));
      } else {
        const entry = ((ST.listing && ST.listing.entries) || []).find((x) => x.name === name);
        ST.sel = entry
          ? { name: entry.name, dir: false, size: entry.size, mtime: entry.mtime }
          : { name, dir: false };
        renderExplorer();
      }
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      const action = act.getAttribute("data-act");
      if (action === "up") {
        const id = ST.active,
          cur = ST.cwd[id] || "",
          listing = ST.listing,
          parent = (listing && listing.id === id && listing.parent) || parentOf(cur);
        if (parent && parent !== cur) {
          ST.navFwd || (ST.navFwd = {});
          (ST.navFwd[id] = ST.navFwd[id] || []).push(cur);
          ST.sel = null;
          ST.filter = "";
          loadDir(id, parent);
        }
      } else if (action === "fwd") {
        const id = ST.active,
          fwdStack = (ST.navFwd || {})[id];
        if (fwdStack && fwdStack.length) {
          const target = fwdStack.pop();
          ST.sel = null;
          ST.filter = "";
          loadDir(id, target);
        }
      } else if (action === "refresh") {
        loadDir(ST.active, ST.cwd[ST.active]);
        toast("Refreshing…");
      } else if (action === "open" && ST.sel) {
        // note: unlike the other directory-enters, "Open" keeps the active filter
        enterDir(ST.active, joinp(ST.cwd[ST.active], ST.sel.name));
      } else if (action === "newterm") {
        openServer(ST.active, "terminal");
      } else if (action === "copypath" && ST.sel) {
        copyText(ST.cwd[ST.active] + "/" + ST.sel.name);
      } else if (action === "download" && ST.sel) {
        const cur = ST.cwd[ST.active];
        doDownload(ST.active, joinp(cur, ST.sel.name));
      } else if (action === "sendto" && ST.sel) {
        const cur = ST.cwd[ST.active];
        openSendTo({
          sid: ST.active,
          path: joinp(cur, ST.sel.name),
          name: ST.sel.name,
          size: ST.sel.size || 0,
        });
      } else if (action === "upload") {
        pickUpload();
      }
      return;
    }
    const prow = e.target.closest(".lt-proc[data-proc-key]");
    if (prow) {
      const procKey = prow.getAttribute("data-proc-key");
      ST.procOpen[procKey] = !ST.procOpen[procKey];
      viewMonitor();
      return;
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "lt-filter") {
      ST.filter = e.target.value;
      renderExplorer();
      const n = $("lt-filter");
      if (n) {
        n.focus();
        n.setSelectionRange(n.value.length, n.value.length);
      }
    } else if (e.target.id === "lt-ovsearch") {
      ST.ovq = e.target.value;
      viewFleet();
      const n = $("lt-ovsearch");
      if (n) {
        n.focus();
        n.setSelectionRange(n.value.length, n.value.length);
      }
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "lt-hidden") {
      ST.hidden = e.target.checked;
      renderExplorer();
    } else if (e.target.id === "lt-day") {
      localStorage.setItem("lt-mode", e.target.checked ? "day" : "night");
      updateTermThemes();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (ST.monitorDrag && e.key === "Escape") {
      e.preventDefault();
      finishMonitorDrag();
      return;
    }
    const monitorHandle =
      e.target.closest && e.target.closest("[data-monitor-drag-handle]");
    if (monitorHandle && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const sectionId = monitorHandle.getAttribute("data-monitor-drag-handle"),
        renderedIds = renderedMonitorSectionIds(),
        currentIndex = renderedIds.indexOf(sectionId),
        direction = e.key === "ArrowUp" ? -1 : 1,
        targetId = renderedIds[currentIndex + direction];
      if (
        targetId &&
        moveMonitorSection(sectionId, targetId, direction > 0)
      ) {
        announceMonitorMove(sectionId, renderedIds);
        ST.monitorFocusSection = sectionId;
        viewMonitor();
      }
      return;
    }
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target.matches &&
      e.target.matches('[role="button"][tabindex="0"]')
    ) {
      e.preventDefault();
      e.target.click();
      return;
    }
    if ($("lt-modal")) {
      if (e.key === "Escape") {
        closeModal();
        return;
      }
      if (
        e.key === "Enter" &&
        e.target.classList &&
        e.target.classList.contains("lt-f-in") &&
        e.target.tagName !== "SELECT"
      ) {
        e.preventDefault();
        submitAdd();
        return;
      }
    }
    if (e.target.id === "lt-find-in") {
      if (e.key === "Enter") {
        e.preventDefault();
        doFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        toggleFind(false);
      }
    }
  });

  /* ---------------- init + polling ---------------- */
  function applyTheme() {
    $("lt-day").checked = (localStorage.getItem("lt-mode") || "day") !== "night";
  }
  async function poll() {
    if (document.hidden) return; // hidden to tray / background tab: don't hammer SSH for an invisible UI
    try {
      const fleet = await api("/api/fleet");
      fleet.servers.forEach((server) => {
        FLEET[server.id] = server;
        syncMineProcessRows(server.id, server);
      });
      if (fleet.rev !== undefined && ST.cfgRev !== undefined && fleet.rev !== ST.cfgRev) {
        await refreshRegistry();
      } // config file edited → re-pull registry
      if (fleet.rev !== undefined) ST.cfgRev = fleet.rev;
      const onlineCount = fleet.servers.filter((server) => server.online !== false).length;
      $("lt-conn").textContent = `${onlineCount}/${fleet.servers.length} hosts online`;
      renderSide();
      if (ST.view === "fleet") {
        if (document.activeElement && document.activeElement.id === "lt-ovsearch") return;
        viewFleet();
      } else {
        renderHeadTabs();
        if (ST.tab === "monitor") viewMonitor();
      }
    } catch (e) {
      $("lt-conn").textContent = "backend unreachable";
    }
  }
  // self-rescheduling loop: the next poll is queued only AFTER the current one resolves, so a
  // slow /api/fleet can never stack overlapping requests (which used to storm the sshds).
  function pollLoop() {
    Promise.resolve(poll())
      .catch(() => {})
      .finally(() => {
        clearTimeout(ST._pollT);
        ST._pollT = setTimeout(pollLoop, FLEET_POLL_MS);
      });
  }
  async function init() {
    applyTheme();
    monitorAnnouncementRegion();
    try {
      ST.collapsed = JSON.parse(localStorage.getItem("lt-collapsed") || "{}") || {};
    } catch (e) {}
    ST.ovmode = localStorage.getItem("lt-ovmode") || "grid";
    try {
      const [serverList, folderList] = await Promise.all([
        api("/api/servers"),
        api("/api/folders"),
      ]);
      SERVERS = serverList;
      FOLDERS = folderList;
    } catch (e) {
      $("lt-view").innerHTML =
        '<div class="lt-empty">Backend not reachable — is the server running?<br>' +
        esc(String(e)) +
        "</div>";
      return;
    }
    byId = Object.fromEntries(SERVERS.map((server) => [server.id, server]));
    ST.active = SERVERS[0] && SERVERS[0].id;
    renderAll();
    startXfer();
    pollLoop();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        clearTimeout(ST._pollT);
        pollLoop();
      }
    }); // fresh data the moment we're shown again
  }
  /* frameless window controls (Tauri global API) */
  document.addEventListener("click", (e) => {
    const ctrl = e.target.closest("[data-wc]");
    if (!ctrl) return;
    const tauri = window.__TAURI__;
    if (tauri && tauri.window) {
      const win = tauri.window.getCurrentWindow();
      const action = ctrl.getAttribute("data-wc");
      if (action === "min") win.minimize();
      else if (action === "max") win.toggleMaximize();
      else if (action === "close") win.close();
    }
  });
  /* drag the frameless window by the titlebar (explicit startDragging — auto drag-region isn't injected for an external-URL window) */
  const _wcSel = ".lt-wc,.lt-theme,.lt-kbd,button,a,input,select";
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const titlebar = e.target.closest(".lt-titlebar");
    if (!titlebar || e.target.closest(_wcSel)) return;
    const tauri = window.__TAURI__;
    if (tauri && tauri.window) tauri.window.getCurrentWindow().startDragging();
  });
  document.addEventListener("dblclick", (e) => {
    const titlebar = e.target.closest(".lt-titlebar");
    if (!titlebar || e.target.closest(_wcSel)) return;
    const tauri = window.__TAURI__;
    if (tauri && tauri.window) tauri.window.getCurrentWindow().toggleMaximize();
  });
  init();
})();
