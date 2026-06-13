(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  function utilColor(u) {
    const clampedPct = Math.max(0, Math.min(100, Math.round(u)));
    return clampedPct <= 50
      ? `color-mix(in srgb,var(--ok),var(--warn) ${clampedPct * 2}%)`
      : `color-mix(in srgb,var(--warn),var(--hot) ${(clampedPct - 50) * 2}%)`;
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
    SIDX = {},
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
    termTabs: {},
    termActive: {},
    broadcast: false,
    sessSeq: 0,
    listing: null,
    loadSeq: 0,
    alert: false,
    collapsed: {},
    hist: {},
    procOpen: {},
    chart: null,
    monTimer: null,
    vimNav: false,
    zoom: 1,
    focus: "main",
    sideCur: null,
    _exItems: [],
    _lastG: 0,
  };

  let toastT;
  function toast(m) {
    const toastEl = $("lt-toast");
    toastEl.textContent = m;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  const gpus = (d) => (d && d.gpus) || [];
  const disks = (d) => (d && d.disks) || [];
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
    if (summary.avg >= 70) return "hot";
    return "busy";
  }
  function tabsFor(server) {
    return server.kind === "nas"
      ? [
          ["explorer", "Explorer", "▤"],
          ["monitor", "Storage", "◷"],
        ]
      : [
          ["explorer", "Explorer", "▤"],
          ["terminal", "Terminal", "▸"],
          ["monitor", "Monitor", "◷"],
        ];
  }

  /* ---------------- sidebar + registry (folders, add/remove) ---------------- */
  function hueOf(id) {
    return ((SIDX[id] || 0) * 47) % 360;
  }
  function svTile(id) {
    const hue = hueOf(id);
    return `--t1:hsl(${hue} 62% 55%);--t2:hsl(${(hue + 34) % 360} 56% 45%)`;
  }
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
    let html = `<div class="lt-ov${ST.view === "fleet" ? " on" : ""}" data-view="fleet"><span class="gly">▦</span>Overview<span class="ct">${free ? free + " GPU FREE" : ""}</span></div>`;
    html += `<div class="lt-side-h"><span>MACHINES</span><span class="lt-addbtn" data-add="server" title="Add a server or folder">+</span></div>`;
    (FOLDERS.length ? FOLDERS : [{ key: "lab", title: "Lab Servers" }]).forEach((f) => {
      const list = SERVERS.filter((server) => (server.group || "lab") === f.key);
      const col = folderCollapsed(f.key);
      html += `<div class="lt-sec${col ? " col" : ""}" data-grp="${esc(f.key)}"><span class="chev">▾</span><span class="lt-sec-t">${esc(f.title)}</span><span class="gn">${list.length}</span><span class="lt-sec-add" data-add="server" data-folder="${esc(f.key)}" title="Add server here">+</span></div>`;
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
          right = `<span class="lt-sv-pct" style="color:${utilColor(gpu.avg)}">${gpu.avg}%</span>`;
        else if (disk && server.kind === "nas")
          right = `<span class="lt-sv-pct">${pct(disk.used, disk.size)}%</span>`;
        const curClass = ST.vimNav && ST.focus === "side" && server.id === ST.sideCur ? " cur" : "";
        html += `<div class="lt-sv${ST.view === "server" && server.id === ST.active ? " on" : ""}${curClass}" data-sv="${server.id}"><span class="lt-svi" style="${svTile(server.id)}">${esc(svCode(server))}<span class="lt-st ${statusDot(status)}"></span></span><span class="lt-svt"><span class="lt-sv-name">${esc(server.name)}</span><span class="lt-sv-sub">${esc(svSub(server))}</span></span>${right}</div>`;
      });
    });
    $("lt-side").innerHTML = html;
  }
  async function refreshRegistry() {
    try {
      const [servers, folders] = await Promise.all([api("/api/servers"), api("/api/folders")]);
      SERVERS = servers;
      FOLDERS = folders;
      byId = Object.fromEntries(SERVERS.map((server) => [server.id, server]));
      SIDX = Object.fromEntries(SERVERS.map((server, i) => [server.id, i]));
      if (ST.active && !byId[ST.active]) {
        ST.view = "fleet";
        ST.active = SERVERS[0] && SERVERS[0].id;
        ST.sel = null;
        ST.listing = null;
        renderAll();
      } // the open server was removed (e.g. config hand-edit)
      if (ST.sideCur && !byId[ST.sideCur]) ST.sideCur = ST.active || (SERVERS[0] && SERVERS[0].id); // vim cursor's server vanished
      renderSide();
    } catch (e) {}
  }
  /* add server / folder modal */
  function openAddModal(mode, folder) {
    _modal = { mode: mode || "server", folder: folder || (FOLDERS[0] && FOLDERS[0].key) || "lab" };
    let element = $("lt-modal");
    if (!element) {
      element = document.createElement("div");
      element.id = "lt-modal";
      element.className = "lt-modal";
      (document.querySelector(".lt-window") || document.body).appendChild(element);
    }
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
          `<div class="lt-ctx-i${item.danger ? " danger" : ""}" data-ci="${i}">${esc(item.label)}</div>`,
      )
      .join("");
    (document.querySelector(".lt-window") || document.body).appendChild(menu);
    // .lt-ctx is position:fixed inside the zoomed .lt-window, so map the real viewport
    // coords (x,y) into the element's zoomed local space by dividing by the zoom factor.
    const zoom = ST.zoom || 1;
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - 198) / zoom) + "px";
    menu.style.top =
      Math.max(0, Math.min(y, window.innerHeight - 14 - items.length * 34) / zoom) + "px";
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
          ST.cwd[ST.active] = full;
          (ST.navFwd || (ST.navFwd = {}))[ST.active] = [];
          ST.sel = null;
          ST.filter = "";
          loadDir(ST.active, full);
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
          `Delete ${dir ? "folder" : "file"} <b style="color:var(--tx)">${esc(name)}</b>${dir ? " <u>and everything inside it</u>" : ""}?<br>This cannot be undone.`,
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
      ? `<b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">${mode === "folder" ? "Rename folder" : "Edit server"}</b>`
      : `<div class="lt-seg"><span class="${mode === "server" ? "on" : ""}" data-mode="server">Server</span><span class="${mode === "folder" ? "on" : ""}" data-mode="folder">Folder</span></div>`;
    const btn = editId ? "Save" : "Add " + (mode === "folder" ? "folder" : "server");
    element.innerHTML = `<div class="lt-modal-card"><div class="lt-modal-h">${head}<span class="lt-modal-x" data-mclose="1">✕</span></div><div class="lt-modal-b">${body}</div><div class="lt-modal-f"><span class="lt-btn ghost" data-mclose="1">Cancel</span><span class="lt-btn" data-msubmit="1">${btn}</span></div></div>`;
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
    if (status.online === false) chips += `<span class="lt-chip hot">offline</span>`;
    else if (gpu) {
      let chipKind;
      if (gpu.avg >= 70) chipKind = "hot";
      else if (gpu.idle === gpu.total) chipKind = "ok";
      else chipKind = "";
      chips += `<span class="lt-chip ${chipKind}">${gpu.total > 1 ? gpu.total + "× GPU" : "GPU"} · ${gpus(
        status,
      )
        .map((x) => x.util + "%")
        .join(" / ")}</span>`;
    } else if (server.kind === "ssh" && status.ncpu)
      chips += `<span class="lt-chip">${status.ncpu} cores · load ${status.load[0]}</span>`;
    if (disk)
      chips += `<span class="lt-chip">${server.kind === "nas" ? "volume" : "disk"} ${pct(disk.used, disk.size)}%</span>`;
    if (status.online !== false) chips += `<span class="lt-chip ok">● live</span>`;
    let addr;
    if (server.kind === "nas") addr = `${server.host}:${server.port}`;
    else if (server.kind === "wsl") addr = "wsl · Ubuntu";
    else addr = `${server.user}@${server.host}:${server.port}`;
    head.innerHTML = `<span class="lt-st ${statusDot(status)}" style="width:10px;height:10px"></span><span class="hnm">${esc(server.name)}</span><span class="hsub">${esc(addr)}${status.up ? " · up " + status.up : ""}</span><div class="chips">${chips}</div>`;
    tabs.innerHTML = tabsFor(server)
      .map(
        ([k, lbl, gly]) =>
          `<div class="tab${ST.tab === k ? " on" : ""}" data-tab="${k}"><span class="gly">${gly}</span>${lbl}</div>`,
      )
      .join("");
  }

  /* ---------------- hosts overview ---------------- */
  function hostMeta(server, idx) {
    const status = FLEET[server.id],
      gpu = gpuSummary(status),
      disk = diskPrimary(status);
    const hue = hueOf(server.id),
      t1 = `hsl(${hue} 66% 56%)`,
      t2 = `hsl(${(hue + 36) % 360} 60% 46%)`;
    let code;
    if (server.kind === "wsl") code = "WS";
    else if (server.kind === "nas") code = "NS";
    else code = server.name.replace(/[^0-9]/g, "") || server.name.slice(0, 2).toUpperCase();
    let addr;
    if (server.kind === "wsl") addr = (server.user || "wsl") + " · Ubuntu";
    else if (server.kind === "nas") addr = `${server.host}:${server.port}`;
    else addr = `${server.user}@${server.host}:${server.port}`;
    let stat;
    if (!status) stat = "connecting…";
    else if (status.online === false) stat = "offline" + (status.error ? " · " + status.error : "");
    else if (gpu)
      stat =
        `GPU ${gpu.avg}% · ${gpu.idle > 0 ? gpu.idle + " idle" : "all busy"}` +
        (disk ? ` · disk ${pct(disk.used, disk.size)}%` : "");
    else if (server.kind === "nas")
      stat = disk
        ? `volume ${pct(disk.used, disk.size)}% · ${bytes(disk.size - disk.used)} free`
        : "—";
    else
      stat =
        (status.ncpu ? `load ${status.load[0]} · ${status.ncpu} cores` : "idle") +
        (disk ? ` · disk ${pct(disk.used, disk.size)}%` : "");
    return { d: status, g: gpu, dk: disk, code, addr, stat, t1, t2 };
  }
  function hostCard(s, idx) {
    const meta = hostMeta(s, idx);
    let tags = `<span class="lt-htag">${esc(s.gpuLabel || s.kind)}</span>`;
    if (meta.g && meta.g.idle > 0)
      tags += `<span class="lt-htag free">${meta.g.idle} GPU FREE</span>`;
    return `<div class="lt-hcard" data-sv="${s.id}"><div class="lt-hgo">Open →</div><div class="lt-htop"><span class="lt-hicon" style="--t1:${meta.t1};--t2:${meta.t2}">${esc(meta.code)}<span class="lt-st ${statusDot(meta.d)}"></span></span><div class="lt-hmeta"><div class="lt-hname">${esc(s.name)}</div><div class="lt-haddr">${esc(meta.addr)}</div></div></div><div class="lt-htags">${tags}</div><div class="lt-hstat">${esc(meta.stat)}</div></div>`;
  }
  function hostRow(s, idx) {
    const meta = hostMeta(s, idx);
    const tag =
      meta.g && meta.g.idle > 0
        ? `<span class="lt-htag free">${meta.g.idle} FREE</span>`
        : `<span class="lt-htag">${esc(s.gpuLabel || s.kind)}</span>`;
    return `<div class="lt-hrow" data-sv="${s.id}"><span class="lt-hicon sm" style="--t1:${meta.t1};--t2:${meta.t2}">${esc(meta.code)}<span class="lt-st ${statusDot(meta.d)}"></span></span><div class="lt-rmeta"><span class="lt-hname">${esc(s.name)}</span><span class="lt-haddr">${esc(meta.addr)}</span></div><span class="lt-rstat">${esc(meta.stat)}</span>${tag}<span class="lt-hgo2">Open →</span></div>`;
  }
  function viewFleet() {
    const query = (ST.ovq || "").toLowerCase();
    const list = SERVERS.filter(
      (s) =>
        !query || (s.name + " " + s.host + " " + (s.gpuLabel || "")).toLowerCase().includes(query),
    );
    const mode = ST.ovmode === "list" ? "list" : "grid";
    let html = `<div class="lt-ovh"><h3>Hosts</h3><span class="ct">${SERVERS.length} machines · key auth</span><div class="lt-vtog"><span class="lt-vbtn${mode === "grid" ? " on" : ""}" data-ov="grid" title="Grid view">▦</span><span class="lt-vbtn${mode === "list" ? " on" : ""}" data-ov="list" title="List view">≡</span></div><input class="lt-ovsearch" id="lt-ovsearch" placeholder="Search hosts…" value="${esc(ST.ovq || "")}"></div>`;
    if (!list.length) html += `<div class="lt-empty">No hosts match “${esc(ST.ovq)}”.</div>`;
    else if (mode === "list")
      html += '<div class="lt-hlist">' + list.map((s, i) => hostRow(s, i)).join("") + "</div>";
    else html += '<div class="lt-hgrid">' + list.map((s, i) => hostCard(s, i)).join("") + "</div>";
    const viewEl = $("lt-view");
    viewEl.className = "lt-view pad";
    viewEl.innerHTML = html;
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
    if (isdir) return '<span class="lt-ic dir"></span>';
    if (islink) return '<span class="lt-ic lnk"></span>';
    const dev = devClass(name);
    return dev ? `<i class="lt-di devicon-${dev} colored"></i>` : '<span class="lt-ic fil"></span>';
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
    const top = `<div class="lt-toolbar"><span class="lt-nav${backDim}" data-act="up" title="Parent folder">←</span><span class="lt-nav${fwdDim}" data-act="fwd" title="Forward — back to where you came from">→</span><span class="lt-nav" data-act="refresh" title="Refresh">↻</span>${server.kind === "ssh" ? '<span class="lt-nav" data-act="upload" title="Upload files here">⇪</span>' : ""}<div class="lt-crumb">${crumbHtml(id, path)}</div><input class="lt-filter" id="lt-filter" placeholder="filter…" value="${esc(ST.filter)}"><label class="lt-chk"><input type="checkbox" id="lt-hidden" ${ST.hidden ? "checked" : ""}>HIDDEN</label></div>`;
    let body;
    if (listing && listing.loading) {
      body = `<div class="lt-ftable"><div class="lt-empty">Listing <b>${esc(server.name)}:${esc(path)}</b> …</div></div>`;
    } else if (listing && listing.error) {
      body = `<div class="lt-ftable"><div class="lt-empty"><b>Couldn’t list this folder.</b><br>${esc(listing.error)}</div></div>`;
    } else {
      const arrow = ST.sort.asc ? "▲" : "▼";
      let table = `<div class="lt-fh"><span data-sort="name">NAME ${ST.sort.key === "name" ? '<span class="ar">' + arrow + "</span>" : ""}</span><span data-sort="size" style="text-align:right">SIZE ${ST.sort.key === "size" ? '<span class="ar">' + arrow + "</span>" : ""}</span><span data-sort="mtime" style="text-align:right">MODIFIED ${ST.sort.key === "mtime" ? '<span class="ar">' + arrow + "</span>" : ""}</span></div>`;
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
      ST._exItems = items; // ordered visible rows — drives j/k cursor movement (vim nav)
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
      return `<aside class="lt-prev"><div class="pic">▣</div><h4>Nothing selected</h4><div class="meta">Click a file to preview.<br>Click a folder to open it.</div><div class="lt-hint">Live listing over ${listingSource(server.kind)}.</div></aside>`;
    const entry = ST.sel;
    if (entry.dir)
      return `<aside class="lt-prev"><div class="pic">▤</div><h4>${esc(entry.name)}</h4><div class="meta">Folder · ${esc(server.name)}<br>${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="open">Open</span><span class="lt-act" data-act="copypath">Copy path</span>${server.kind !== "nas" ? '<span class="lt-act" data-act="newterm">Open terminal here</span>' : ""}</aside>`;
    const ext = (entry.name.split(".").pop() || "").toLowerCase();
    const icon =
      {
        pt: "◆",
        pth: "◆",
        ckpt: "◆",
        yaml: "⚙",
        yml: "⚙",
        json: "⚙",
        log: "▦",
        jsonl: "▦",
        sh: "▶",
        csh: "▶",
        py: "⌘",
        bib: "❡",
        pdf: "▤",
        php: "⟨⟩",
        dat: "▦",
      }[ext] || "▢";
    return `<aside class="lt-prev"><div class="pic">${icon}</div><h4>${esc(entry.name)}</h4><div class="meta">${bytes(entry.size)} · ${esc(ext || "file")}<br>${entry.mtime ? "modified " + ago(entry.mtime) : ""}<br>${esc(server.name)}:${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="sendto">Send to…</span><span class="lt-act" data-act="download">Download</span><span class="lt-act" data-act="copypath">Copy path</span></aside>`;
  }

  /* ---------------- explorer file CRUD (context menu + dialogs) ---------------- */
  function joinp(dir, name) {
    return (dir === "/" || dir === "" || dir == null ? "" : dir) + "/" + name;
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
      `<div class="lt-modal-card"><div class="lt-modal-h"><b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">${esc(title)}</b><span class="lt-modal-x" data-pclose="1">✕</span></div><div class="lt-modal-b"><input class="lt-f-in" id="lt-prompt-in" value="${esc(initial || "")}" spellcheck="false"></div><div class="lt-modal-f"><span class="lt-btn ghost" data-pclose="1">Cancel</span><span class="lt-btn" data-pok="1">OK</span></div></div>`,
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
      `<div class="lt-modal-card"><div class="lt-modal-h"><b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">Are you sure?</b><span class="lt-modal-x" data-pclose="1">✕</span></div><div class="lt-modal-b" style="font-size:12.5px;color:var(--tx2);line-height:1.65">${html}</div><div class="lt-modal-f"><span class="lt-btn ghost" data-pclose="1">Cancel</span><span class="lt-btn" data-pok="1" style="background:var(--err);border-color:var(--err)">Delete</span></div></div>`,
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
    state.timer = setInterval(xferTick, 1500);
    xferTick();
  }
  function toggleDrawer(open) {
    const state = xfer();
    state.open = open != null ? open : !state.open;
    if (state.open) startXfer();
    renderDrawer();
  }
  function xferDirGlyph(kind) {
    if (kind === "upload") return "↑";
    if (kind === "download") return "↓";
    return "→";
  }
  function xferStateColor(state) {
    if (state === "error") return "var(--hot)";
    if (state === "done") return "var(--ok)";
    if (state === "canceled") return "var(--dim)";
    return "var(--acc)";
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
          const dirGlyph = xferDirGlyph(job.kind);
          const stateColor = xferStateColor(job.state);
          const isActive = job.state === "active" || job.state === "queued";
          return `<div class="lt-xrow"><div class="lt-xtop"><span class="lt-xlabel" title="${esc(job.label)}">${dirGlyph} ${esc(job.label)}</span>${isActive ? `<span class="lt-xcancel" data-xcancel="${job.id}" title="Cancel">✕</span>` : `<span class="lt-xstate" style="color:${stateColor}">${job.state}</span>`}</div><div class="lt-xbar"><span class="lt-xfill" style="width:${percent}%;background:${stateColor}"></span></div><div class="lt-xsub"><span>${job.total ? bytes(job.done) + " / " + bytes(job.total) : bytes(job.done)}</span><span>${xferProgressLabel(job, percent)}</span></div></div>`;
        })
        .join("") ||
      '<div class="lt-xempty">No transfers yet.<br>Use “Send to…”, “Download”, or “Upload”.</div>';
    drawerEl.innerHTML = `<div class="lt-xhead"><b>Transfers</b><span class="lt-grow"></span><span class="lt-xbtn" data-xfer="clear">Clear done</span><span class="lt-xbtn" data-xclose="1">✕</span></div><div class="lt-xbody">${rows}</div>`;
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
    modalEl.innerHTML = `<div class="lt-modal-card"><div class="lt-modal-h"><b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">Send “${esc(src.name)}”</b><span class="lt-modal-x" data-sclose="1">✕</span></div><div class="lt-modal-b"><div class="lt-f-grid"><div class="lt-f-wide"><label class="lt-f-l">Destination host</label><select class="lt-f-in" id="st-host">${options}</select></div><div class="lt-f-wide"><label class="lt-f-l">Destination folder</label><input class="lt-f-in" id="st-path" value="${esc((defaultDest && defaultDest.home) || "/")}" placeholder="/home/you"></div></div><div class="lt-hint">Copies over the lab network (server→server or →NAS), streamed with live progress in Transfers.</div></div><div class="lt-modal-f"><span class="lt-btn ghost" data-sclose="1">Cancel</span><span class="lt-btn" data-ssubmit="1">Send</span></div></div>`;
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
  function cssvar(n) {
    return (
      getComputedStyle(document.querySelector(".lt-window")).getPropertyValue(n).trim() || "#000"
    );
  }
  function xtermTheme() {
    const bg = cssvar("--bg"),
      tx = cssvar("--tx"),
      acc = cssvar("--acc"),
      ok = cssvar("--ok"),
      warn = cssvar("--warn"),
      hot = cssvar("--hot"),
      cy = cssvar("--cy"),
      dim = cssvar("--dim"),
      dim2 = cssvar("--dim2"),
      tx2 = cssvar("--tx2");
    return {
      background: bg,
      foreground: tx,
      cursor: acc,
      cursorAccent: bg,
      selectionBackground: acc + "55",
      black: dim2,
      red: hot,
      green: ok,
      yellow: warn,
      blue: acc,
      magenta: acc,
      cyan: cy,
      white: tx2,
      brightBlack: dim,
      brightRed: hot,
      brightGreen: ok,
      brightYellow: warn,
      brightBlue: acc,
      brightMagenta: acc,
      brightCyan: cy,
      brightWhite: tx,
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
      html += `<span class="lt-ttab${on ? " on" : ""}" data-sess="${k}">sh${i + 1}${tabs.length > 1 ? ` <b data-close="${k}">✕</b>` : ""}</span>`;
    });
    html += `<span class="lt-ttab add" data-newsess="1" title="New shell on this host">+</span>`;
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
        "'JetBrainsMono Nerd Font','MesloLGS NF','CaskaydiaCove Nerd Font','Hack Nerd Font','JetBrains Mono','Symbols Nerd Font Mono',ui-monospace,monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 8000,
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
    if (file.size > 512 * 1024) {
      toast("Too big to paste (>512 KB)");
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
    dir < 0 ? session.search.findPrevious(query) : session.search.findNext(query);
  }
  function toggleFind(show) {
    const findEl = $("lt-find");
    if (!findEl) return;
    const vis = show === undefined ? findEl.style.display === "none" : show;
    findEl.style.display = vis ? "flex" : "none";
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
    view.innerHTML = `<div class="lt-term${ST.broadcast ? " bcast" : ""}"><div class="lt-term-bar"><span class="lt-led off" id="lt-term-led"></span><span>${server.kind === "wsl" ? "wsl.exe" : "ssh"} · ${esc(server.host)}${server.kind === "ssh" ? ":" + server.port : ""}</span><span id="lt-term-stat-c">…</span><span class="lt-ttabs" id="lt-ttabs"></span><span class="lt-grow"></span><span class="lt-tbtn${ST.broadcast ? " on" : ""}" data-tact="broadcast" title="Mirror keystrokes to every open session">⇉ Broadcast</span><span class="lt-tbtn" data-tact="find" title="Search scrollback (Ctrl+F)">Find</span><span class="lt-tbtn" data-tact="clear">Clear</span><span class="lt-tbtn" data-tact="reconnect">Reconnect</span></div><div class="lt-find" id="lt-find" style="display:none"><input id="lt-find-in" placeholder="search scrollback — Enter / Shift+Enter" autocomplete="off"><span class="lt-tbtn" data-tact="find-prev">▴</span><span class="lt-tbtn" data-tact="find-next">▾</span><span class="lt-tbtn" data-tact="find-close">✕</span></div><div class="lt-term-mount" id="lt-term-mount"></div></div>`;
    const key = activeKey(id);
    if (key && SESS[key]) attachSession(key);
    else openSession(id);
  }

  /* ---------------- monitor (availability · trends · processes · vitals) ---------------- */
  function tempColor(temp) {
    return utilColor(Math.max(0, Math.min(100, (temp - 30) / 0.6)));
  }
  function userColor(user) {
    let hash = 0;
    user = user || "";
    for (let i = 0; i < user.length; i++) hash = (hash * 31 + user.charCodeAt(i)) % 360;
    return `hsl(${hash} 58% 55%)`;
  }
  function gpuHue(ix) {
    return `hsl(${(ix * 67) % 360} 70% 55%)`;
  }
  function pushHist(id) {
    const fleet = FLEET[id];
    if (!fleet || !fleet.gpus) return;
    fleet.gpus.forEach((gpu, i) => {
      const key = id + ":" + (gpu.index != null ? gpu.index : i);
      const samples = ST.hist[key] || (ST.hist[key] = []);
      samples.push({ u: gpu.util, m: pct(gpu.mu, gpu.mt) });
      if (samples.length > 48) samples.shift();
    });
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
      svg += `<polygon points="${line} ${W},${H} 0,${H}" style="fill:${entry.color};fill-opacity:.15"></polygon><polyline points="${line}" style="stroke:${entry.color}"></polyline>`;
    });
    const labs = series
      .map((entry) => {
        const lv = entry.pts.length ? entry.pts[entry.pts.length - 1] : 0,
          top = (1 - lv / 100) * 100;
        return `<span class="lt-lc-dot" style="top:${top}%;background:${entry.color}"></span><span class="lt-lc-lab" style="top:${top}%;color:${entry.color}">${esc(entry.label)} ${Math.round(lv)}%</span>`;
      })
      .join("");
    return `<div class="lt-chart" data-metric="${metric || ""}"><div class="lt-chart-ax"><span>100</span><span>50</span><span>0</span></div><svg class="lt-lc" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg>${labs}</div>`;
  }
  function viewMonitor() {
    const id = ST.active,
      server = byId[id],
      fleet = FLEET[id];
    const view = $("lt-view");
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
    const bar = (p, c, extra) =>
      `<span class="lt-bar"><span class="lt-fill" style="width:${Math.max(0, Math.min(100, p))}%;color:${c}"></span>${extra || ""}</span>`;
    let html = '<div class="lt-mon">';
    /* PANEL 1 — availability strip (free VRAM is the hero) */
    if (gpuList.length) {
      const free = gpuList.filter((gpu) => gpu.util < 10 && pct(gpu.mu, gpu.mt) < 10).length;
      html += `<div class="lt-mhd"><b>GPUs</b><span class="ln"></span><span class="cnt">${free}/${gpuList.length} free</span></div><div class="lt-avail">`;
      gpuList.forEach((gpu, i) => {
        const ix = gpu.index != null ? gpu.index : i,
          mp = pct(gpu.mu, gpu.mt),
          fGB = GB(gpu.mt - gpu.mu),
          isFree = gpu.util < 10 && mp < 10,
          mc = utilColor(mp);
        html +=
          `<div class="lt-av${isFree ? " free" : ""}"><div class="lt-av-top"><span class="lt-av-ix" style="color:${gpuHue(ix)}">GPU ${ix}</span><span class="lt-av-model">${esc(gpu.name)}</span><span class="lt-av-t" style="color:${tempColor(gpu.temp)}">${gpu.temp}°C</span></div>` +
          `<div class="lt-av-free"><b style="color:${isFree ? "var(--ok)" : mc}">${fGB.toFixed(1)}</b><span>GB free</span>${isFree ? '<span class="lt-av-pill">FREE</span>' : `<em>${gpu.util}% util</em>`}</div>` +
          bar(
            mp,
            mc,
            `<span class="lt-av-mark" style="left:${Math.max(0, Math.min(100, gpu.util))}%"></span>`,
          ) +
          `<div class="lt-av-sub"><span>${GB(gpu.mu).toFixed(1)} / ${GB(gpu.mt).toFixed(0)} GB</span><span>${Math.round(gpu.pow)}/${gpu.plim} W</span></div></div>`;
      });
      html += "</div>";
    } else if (server.kind !== "nas") {
      html += `<div class="lt-mhd"><b>GPUs</b><span class="ln"></span></div><div class="lt-note">No GPU on this host — CPU server · ${fleet.ncpu || "?"} cores · load ${fleet.load ? fleet.load[0] : "?"}</div>`;
    }
    /* PANEL 3 — processes */
    if (server.kind !== "nas") {
      const procs = (fleet.procs || []).slice().sort((a, b) => (b.mem || 0) - (a.mem || 0));
      html += `<div class="lt-mhd"><b>Processes</b><span class="ln"></span><span class="cnt">${procs.length}</span></div><div class="lt-panel"><div class="lt-proc-h"><span>USER</span><span>PID</span><span>GPU</span><span>VRAM</span><span>TIME</span><span>COMMAND</span></div>`;
      if (procs.length)
        procs.forEach((proc) => {
          html +=
            `<div class="lt-proc${proc.user === server.user ? " me" : ""}${ST.procOpen[proc.pid] ? " open" : ""}" data-pid="${proc.pid}"><span class="lt-proc-u"><i style="color:${userColor(proc.user)}"></i>${esc(proc.user)}</span><span class="lt-proc-pid">${proc.pid}</span><span class="lt-proc-gpu">${proc.gpu}</span><span class="lt-proc-mem">${GB(proc.mem).toFixed(1)} GB</span><span class="lt-proc-time">${esc(proc.etime || "")}</span><span class="lt-proc-cmd" title="${esc(proc.cmd || "")}">${esc(proc.cmd || "")}</span></div>` +
            (ST.procOpen[proc.pid] ? `<div class="lt-proc-full">${esc(proc.cmd || "")}</div>` : "");
        });
      else
        html += `<div class="lt-proc-empty">No GPU processes${gpuList.length ? " — GPUs idle, or other users’ jobs not visible" : ""}.</div>`;
      html += "</div>";
    }
    /* PANEL 4 — host vitals (bullet bars) */
    const bl = (label, val, p, c, sub) =>
      `<div class="lt-bl"><div class="lt-bl-top"><span>${esc(label)}</span><span>${val}</span></div>${bar(p, c)}${sub ? `<div class="lt-bl-sub">${sub}</div>` : ""}</div>`;
    let vitals = "";
    if (server.kind !== "nas") {
      const lp = fleet.ncpu ? Math.min(100, (fleet.load[0] / fleet.ncpu) * 100) : 0;
      vitals += bl(
        "CPU load",
        `${fleet.load ? fleet.load[0] : "—"} / ${fleet.ncpu || "?"}`,
        lp,
        utilColor(lp),
        `${Math.round(lp)}% of ${fleet.ncpu || "?"} cores`,
      );
      if (fleet.mem) {
        const mp = pct(fleet.mem.used, fleet.mem.total);
        vitals += bl(
          "System RAM",
          `${bytes(fleet.mem.used)} / ${bytes(fleet.mem.total)}`,
          mp,
          "var(--cy)",
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
        utilColor(p),
        `${bytes(disk.size - disk.used)} free · ${p}%`,
      );
    });
    let uptimeLabel = "";
    if (server.kind === "nas") uptimeLabel = "volume";
    else if (fleet.up) uptimeLabel = "up " + fleet.up;
    html += `<div class="lt-mhd"><b>Host${server.kind === "nas" ? " · storage" : ""}</b><span class="ln"></span><span class="cnt">${uptimeLabel}</span></div><div class="lt-vitals">${vitals || '<div class="lt-proc-empty">No vitals reported.</div>'}</div>`;
    /* PANEL — trends (history) at the bottom */
    if (gpuList.length) {
      const mk = (which) =>
        gpuList.map((gpu, i) => {
          const ix = gpu.index != null ? gpu.index : i,
            samples = ST.hist[id + ":" + ix] || [{ u: gpu.util, m: pct(gpu.mu, gpu.mt) }];
          return {
            label: "GPU" + ix,
            color: gpuHue(ix),
            pts: samples.map((sample) => sample[which]),
          };
        });
      const utilSeries = mk("u"),
        vramSeries = mk("m");
      ST.chart = { u: { series: utilSeries, sec: 2 }, m: { series: vramSeries, sec: 2 } };
      const span = Math.max(
        1,
        ...gpuList.map((gpu, i) => {
          const ix = gpu.index != null ? gpu.index : i;
          return (ST.hist[id + ":" + ix] || []).length;
        }),
      );
      const mins = Math.round(((span * 2) / 60) * 10) / 10;
      html += `<div class="lt-mhd"><b>Utilization</b><span class="ln"></span><span class="cnt">% · last ${span < 2 ? "now" : mins + " min"}</span></div>${lineChart(utilSeries, null, "u")}`;
      html += `<div class="lt-mhd"><b>VRAM</b><span class="ln"></span><span class="cnt">% of total · 90% danger</span></div>${lineChart(vramSeries, 90, "m")}`;
    }
    if (gpuList.length)
      html += `<div class="lt-alert${ST.alert ? " on" : ""}" id="lt-alert" style="margin-top:8px"><span class="tog"></span><div><b>Alert me when a GPU here is free for 10 minutes</b><br><span>Desktop notification — grab it before someone else does.</span></div></div>`;
    html += "</div>";
    view.innerHTML = html;
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
      api("/api/" + cur + "/status")
        .then((status) => {
          FLEET[cur] = status;
          pushHist(cur);
          if (ST.view === "server" && ST.tab === "monitor" && ST.active === cur) viewMonitor();
        })
        .catch(() => {});
    }, 2000);
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
      viewMonitor();
      startMon();
    }
  }
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
    // tip/guide live inside the zoomed .lt-window; getBoundingClientRect/clientX are visual
    // (zoomed) coords, so divide by zoom to map them into the element's local space.
    const zoom = ST.zoom || 1;
    guide.style.display = "block";
    guide.style.left = px / zoom + "px";
    guide.style.top = rect.top / zoom + "px";
    guide.style.height = rect.height / zoom + "px";
    const agoSec = (n - 1 - idx) * data.sec;
    tip.innerHTML =
      `<div class="tt">${agoSec <= 0 ? "now" : "~" + agoSec + "s ago"}</div>` +
      series
        .map((s) => {
          const v = s.pts[Math.min(idx, s.pts.length - 1)] || 0;
          return `<div><span style="color:${s.color}">●</span> ${esc(s.label)} <b>${Math.round(v)}%</b></div>`;
        })
        .join("");
    tip.style.display = "block";
    const tipWidth = tip.offsetWidth * zoom;
    let tipX = px + 12;
    if (tipX + tipWidth > window.innerWidth - 8) tipX = px - tipWidth - 12;
    tip.style.left = tipX / zoom + "px";
    tip.style.top = (rect.top + 6) / zoom + "px";
  });
  function renderAll() {
    renderSide();
    renderHeadTabs();
    renderView();
  }
  function openServer(id, tab) {
    ST.view = "server";
    ST.active = id;
    ST.focus = "main";
    ST.sideCur = id;
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
    if (e.target.closest("[data-settings]")) {
      openSettings();
      return;
    }
    if (e.target.id === "lt-settings" || e.target.closest("[data-setclose]")) {
      closeSettings();
      return;
    }
    {
      const z = e.target.closest("[data-zoom]");
      if (z) {
        zoomStep(z.getAttribute("data-zoom") === "1" ? 0.1 : -0.1);
        return;
      }
    }
    if (e.target.closest("[data-vimtoggle]")) {
      setVim(!ST.vimNav);
      const legend = document.querySelector("#lt-settings .lt-set-legend");
      if (legend) legend.classList.toggle("dim", !ST.vimNav);
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
      if (ST.vimNav && ST.sideCur && !sideOrder().includes(ST.sideCur))
        ST.sideCur = sideOrder()[0] || null;
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
    const go = e.target.closest("[data-go]");
    if (go) {
      ST.cwd[ST.active] = go.getAttribute("data-go");
      (ST.navFwd || (ST.navFwd = {}))[ST.active] = [];
      ST.sel = null;
      ST.filter = "";
      loadDir(ST.active, ST.cwd[ST.active]);
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
        const cur = ST.cwd[ST.active];
        ST.cwd[ST.active] = joinp(cur, name);
        (ST.navFwd || (ST.navFwd = {}))[ST.active] = [];
        ST.sel = null;
        ST.filter = "";
        loadDir(ST.active, ST.cwd[ST.active]);
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
        const cur = ST.cwd[ST.active];
        ST.cwd[ST.active] = joinp(cur, ST.sel.name);
        (ST.navFwd || (ST.navFwd = {}))[ST.active] = [];
        ST.sel = null;
        loadDir(ST.active, ST.cwd[ST.active]);
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
    const prow = e.target.closest(".lt-proc[data-pid]");
    if (prow) {
      const pid = prow.getAttribute("data-pid");
      ST.procOpen[pid] = !ST.procOpen[pid];
      viewMonitor();
      return;
    }
    const alertEl = e.target.closest("#lt-alert");
    if (alertEl) {
      ST.alert = !ST.alert;
      alertEl.classList.toggle("on", ST.alert);
      toast(ST.alert ? "Alert on (prototype)" : "Alert off");
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
    } else if (e.target.name === "ltpal") {
      localStorage.setItem("lt-pal", e.target.id.replace("th-", ""));
      updateTermThemes();
    } else if (e.target.id === "lt-day") {
      localStorage.setItem("lt-mode", e.target.checked ? "day" : "night");
      updateTermThemes();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ($("lt-settings") && e.key === "Escape") {
      closeSettings();
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

  /* ---------------- settings: UI zoom + vim navigation ---------------- */
  function refitTerm() {
    const session = SESS[activeKey(ST.active)];
    if (session) {
      try {
        session.fit.fit();
      } catch (e) {}
    }
  }
  function applyZoom() {
    const win = document.querySelector(".lt-window");
    if (win) {
      const zoom = ST.zoom || 1;
      win.style.zoom = zoom;
      // .lt-window is locked to 100vh/100% under body{overflow:hidden}; pre-shrink it by 1/z so
      // that after the ×z zoom it still fills the OS window exactly (no clipped status bar / edge).
      win.style.width = 100 / zoom + "%";
      win.style.height = 100 / zoom + "vh";
    }
    const label = $("lt-set-zoom");
    if (label) label.textContent = Math.round((ST.zoom || 1) * 100) + "%";
    setTimeout(refitTerm, 30);
  }
  function setZoom(zoom) {
    ST.zoom = Math.max(0.7, Math.min(1.6, Math.round(zoom * 20) / 20));
    try {
      localStorage.setItem("lt-zoom", ST.zoom);
    } catch (e) {}
    applyZoom();
  }
  function zoomStep(delta) {
    setZoom((ST.zoom || 1) + delta);
  }
  function setVim(on) {
    ST.vimNav = !!on;
    try {
      localStorage.setItem("lt-vim", on ? "1" : "0");
    } catch (e) {}
    if (on && !ST.sideCur) ST.sideCur = ST.active || sideOrder()[0];
    renderSide();
    const toggle = $("lt-set-vim");
    if (toggle) toggle.classList.toggle("on", ST.vimNav);
    toast(on ? "Vim navigation on — h j k l" : "Vim navigation off");
  }
  function openSettings() {
    if ($("lt-settings")) {
      closeSettings();
      return;
    }
    const el = document.createElement("div");
    el.id = "lt-settings";
    el.className = "lt-modal";
    el.innerHTML = settingsHtml();
    (document.querySelector(".lt-window") || document.body).appendChild(el);
  }
  function closeSettings() {
    const el = $("lt-settings");
    if (el) el.remove();
  }
  function settingsHtml() {
    return `<div class="lt-modal-card"><div class="lt-modal-h"><b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">Settings</b><span class="lt-modal-x" data-setclose="1">✕</span></div>
 <div class="lt-modal-b">
  <div class="lt-set-row"><div class="lt-set-lab"><b>Interface size</b><span>Zoom the whole UI. Shortcut: Ctrl&nbsp;+ / Ctrl&nbsp;− / Ctrl&nbsp;0</span></div><div class="lt-zoomctl"><span class="lt-zbtn" data-zoom="-1" title="Zoom out">−</span><b id="lt-set-zoom">${Math.round((ST.zoom || 1) * 100)}%</b><span class="lt-zbtn" data-zoom="1" title="Zoom in">＋</span></div></div>
  <div class="lt-set-row"><div class="lt-set-lab"><b>Vim navigation</b><span>Move between panels and tabs with h&nbsp;j&nbsp;k&nbsp;l.</span></div><span class="lt-toggle${ST.vimNav ? " on" : ""}" id="lt-set-vim" data-vimtoggle="1"><i></i></span></div>
  <div class="lt-set-legend${ST.vimNav ? "" : " dim"}"><div><kbd>j</kbd><kbd>k</kbd> down / up &nbsp;·&nbsp; <kbd>l</kbd>/<kbd>↵</kbd> open / enter &nbsp;·&nbsp; <kbd>h</kbd> up a folder / sidebar</div><div><kbd>Ctrl</kbd><kbd>h</kbd>/<kbd>l</kbd> switch panel &nbsp;·&nbsp; <kbd>⇧H</kbd>/<kbd>⇧L</kbd> switch tab &nbsp;·&nbsp; <kbd>gg</kbd>/<kbd>G</kbd> top / bottom</div><div>In the Terminal, plain keys go to the shell — use <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>h</kbd>/<kbd>l</kbd> for tabs, <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>k</kbd> for sidebar.</div></div>
 </div>
 <div class="lt-modal-f"><span class="lt-btn" data-setclose="1">Done</span></div></div>`;
  }

  function sideOrder() {
    const out = [];
    (FOLDERS.length ? FOLDERS : [{ key: "lab" }]).forEach((folder) => {
      if (folderCollapsed(folder.key)) return;
      SERVERS.filter((server) => (server.group || "lab") === folder.key).forEach((server) =>
        out.push(server.id),
      );
    });
    return out;
  }
  function scrollCur(sel) {
    const el = document.querySelector(sel);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  function setFocus(which) {
    if (which === "main" && ST.view !== "server") return;
    ST.focus = which;
    if (which === "side") {
      if (!ST.sideCur) ST.sideCur = ST.active || sideOrder()[0];
      renderSide();
      scrollCur(".lt-sv.cur");
    } else {
      renderSide();
      if (ST.tab === "terminal") {
        const session = SESS[activeKey(ST.active)];
        if (session)
          setTimeout(() => {
            try {
              session.term.focus();
            } catch (e) {}
          }, 0);
      }
    }
  }
  function cycleTab(dir) {
    if (ST.view !== "server") return;
    const server = byId[ST.active];
    if (!server) return;
    const tabKeys = tabsFor(server).map((tab) => tab[0]);
    let i = tabKeys.indexOf(ST.tab);
    if (i < 0) i = 0;
    ST.tab = tabKeys[(i + dir + tabKeys.length) % tabKeys.length];
    ST.sel = null;
    ST.focus = "main";
    renderHeadTabs();
    renderView();
  }
  function vimMove(dir) {
    if (ST.view === "fleet" || ST.focus === "side") {
      const order = sideOrder();
      if (!order.length) return;
      let i = order.indexOf(ST.sideCur);
      if (i < 0) {
        // cursor's folder was collapsed — snap to the nearest still-visible server by full order
        const fullOrder = SERVERS.map((server) => server.id),
          fullPos = fullOrder.indexOf(ST.sideCur);
        if (fullPos < 0) {
          i = dir > 0 ? 0 : order.length - 1;
        } else if (dir > 0) {
          i = order.findIndex((id) => fullOrder.indexOf(id) >= fullPos);
          if (i < 0) i = order.length - 1;
        } else {
          i = 0;
          for (let n = order.length - 1; n >= 0; n--) {
            if (fullOrder.indexOf(order[n]) <= fullPos) {
              i = n;
              break;
            }
          }
        }
      } else {
        i = Math.max(0, Math.min(order.length - 1, i + dir));
      }
      ST.sideCur = order[i];
      if (ST.focus !== "side" && ST.view !== "fleet") ST.focus = "side";
      renderSide();
      scrollCur(".lt-sv.cur");
      return;
    }
    if (ST.tab === "explorer") {
      const items = ST._exItems || [];
      if (!items.length) return;
      let i = ST.sel ? items.findIndex((row) => row.name === ST.sel.name) : -1;
      if (i < 0) {
        i = dir > 0 ? 0 : items.length - 1;
      } else {
        i = Math.max(0, Math.min(items.length - 1, i + dir));
      }
      const row = items[i];
      ST.sel = { name: row.name, dir: row.isdir, size: row.size, mtime: row.mtime };
      renderExplorer();
      scrollCur(".lt-fr.sel");
      return;
    }
    if (ST.tab === "monitor") {
      const view = $("lt-view");
      if (view) view.scrollBy({ top: dir * 90 });
    }
  }
  function vimEnter() {
    if (ST.view === "fleet" || ST.focus === "side") {
      if (ST.sideCur) openServer(ST.sideCur);
      return;
    }
    if (ST.tab === "explorer" && ST.sel && ST.sel.dir) {
      const cwd = ST.cwd[ST.active] || "/";
      ST.cwd[ST.active] = joinp(cwd, ST.sel.name);
      (ST.navFwd || (ST.navFwd = {}))[ST.active] = [];
      ST.sel = null;
      ST.filter = "";
      loadDir(ST.active, ST.cwd[ST.active]);
    }
  }
  function vimLeft() {
    if (ST.focus === "main" && ST.tab === "explorer") {
      const cwd = ST.cwd[ST.active] || "/";
      const parent = (ST.listing && ST.listing.parent) || parentOf(cwd);
      if (parent && parent !== cwd) {
        ST.sel = null;
        loadDir(ST.active, parent);
        return;
      }
    }
    setFocus("side");
  }
  function vimJump(where) {
    if (ST.view === "fleet" || ST.focus === "side") {
      const order = sideOrder();
      if (!order.length) return;
      ST.sideCur = where === "top" ? order[0] : order[order.length - 1];
      renderSide();
      scrollCur(".lt-sv.cur");
      return;
    }
    if (ST.tab === "explorer") {
      const items = ST._exItems || [];
      if (!items.length) return;
      const row = where === "top" ? items[0] : items[items.length - 1];
      ST.sel = { name: row.name, dir: row.isdir, size: row.size, mtime: row.mtime };
      renderExplorer();
      scrollCur(".lt-fr.sel");
    }
  }
  function vimKey(e) {
    const target = e.target,
      tag = (target.tagName || "").toUpperCase();
    const inTerm = ST.view === "server" && ST.tab === "terminal";
    const editing =
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    const formInput = editing && !(inTerm && tag === "TEXTAREA"); // a real form field, not the terminal's textarea
    // global shortcuts (work regardless of vim setting) — but never steal from a form field
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !formInput) {
      if (e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomStep(0.05);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomStep(-0.05);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }
    if (!ST.vimNav) return;
    if ($("lt-modal") || $("lt-settings") || $("lt-prompt") || $("lt-sendto") || $("lt-ctx"))
      return; // a dialog/menu owns the keys
    // Ctrl+Alt combos: terminal-safe (no shell/editor binds these), so they work everywhere
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
      const key = (e.key || "").toLowerCase();
      if (key === "h" || e.key === "ArrowLeft") {
        e.preventDefault();
        cycleTab(-1);
        return;
      }
      if (key === "l" || e.key === "ArrowRight") {
        e.preventDefault();
        cycleTab(1);
        return;
      }
      if (key === "k") {
        e.preventDefault();
        setFocus("side");
        return;
      }
      if (key === "j") {
        e.preventDefault();
        setFocus("main");
        return;
      }
    }
    if (editing || inTerm || e.metaKey) return; // don't steal keys from typing or the shell
    if (e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "H") {
        e.preventDefault();
        cycleTab(-1);
        return;
      }
      if (e.key === "L") {
        e.preventDefault();
        cycleTab(1);
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        vimJump("bottom");
        return;
      }
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === "h") {
        e.preventDefault();
        setFocus("side");
        return;
      }
      if (e.key === "l") {
        e.preventDefault();
        setFocus("main");
        return;
      }
      return;
    }
    if (e.ctrlKey || e.altKey) return;
    if (e.key === "j") {
      e.preventDefault();
      vimMove(1);
    } else if (e.key === "k") {
      e.preventDefault();
      vimMove(-1);
    } else if (e.key === "h") {
      e.preventDefault();
      vimLeft();
    } else if (e.key === "l" || e.key === "Enter") {
      e.preventDefault();
      vimEnter();
    } else if (e.key === "g") {
      e.preventDefault();
      const now = performance.now();
      if (ST._lastG && now - ST._lastG < 600) {
        ST._lastG = 0;
        vimJump("top");
      } else ST._lastG = now;
    }
  }
  document.addEventListener("keydown", vimKey, true); // capture phase: beat xterm for the Ctrl+Alt combos

  /* ---------------- init + polling ---------------- */
  function applyTheme() {
    const pal = localStorage.getItem("lt-pal") || "sol",
      mode = localStorage.getItem("lt-mode") || "day";
    const radio = $("th-" + pal);
    if (radio) radio.checked = true;
    $("lt-day").checked = mode !== "night";
  }
  async function poll() {
    if (document.hidden) return; // hidden to tray / background tab: don't hammer SSH for an invisible UI
    try {
      const fleet = await api("/api/fleet");
      fleet.servers.forEach((server) => {
        FLEET[server.id] = server;
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
        ST._pollT = setTimeout(pollLoop, 5000);
      });
  }
  async function init() {
    applyTheme();
    ST.vimNav = localStorage.getItem("lt-vim") === "1";
    const zoom = parseFloat(localStorage.getItem("lt-zoom"));
    if (zoom >= 0.7 && zoom <= 1.6) ST.zoom = zoom;
    applyZoom();
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
    SIDX = Object.fromEntries(SERVERS.map((server, i) => [server.id, i]));
    ST.active = SERVERS[0] && SERVERS[0].id;
    ST.sideCur = ST.active;
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
  const _wcSel = ".lt-wc,.lt-theme,.lt-kbd,.lt-gear,button,a,input,select";
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
