import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "./App.css";

type PortProcess = {
  pid: number;
  killPid: number;
  port: number;
  address: string;
  processName: string;
  processType: string;
  framework: string | null;
  restartCommand: string | null;
  restartCwd: string | null;
  status: string;
  isZombie: boolean;
  cwd: string | null;
  projectName: string | null;
};

type KillResult = { pid: number; killed: boolean; message: string };
type View = "ports" | "workspaces" | "reservations" | "zombies";
type Theme = "dark" | "light";
type ProcessNode = { pid: number; name: string; status: string; memoryBytes: number; children: ProcessNode[] };
type RestartResult = { killedPid: number; spawnedPid: number; command: string };
type ProcessMetric = { pid: number; cpuPercent: number; memoryBytes: number };
type PortReservation = {
  port: number;
  projectName: string;
  cwd: string | null;
  autoKill: boolean;
};
type PortCollision = {
  reservation: PortReservation;
  intruder: PortProcess;
  kind: "hijack" | "vite-fallback";
};

const formatMemory = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function notifyCollision(message: string, title = "Tatas Killer: port collision") {
  let granted = await isPermissionGranted();
  if (!granted) granted = await requestPermission() === "granted";
  if (granted) sendNotification({ title, body: message });
}

function ProcessTreeNode({ node, listenerPid }: { node: ProcessNode; listenerPid: number }) {
  return <li>
    <div className={node.pid === listenerPid ? "tree-node listener-node" : "tree-node"}>
      <span className="tree-dot" />
      <strong>{node.name}</strong>
      <span>PID {node.pid}</span>
      <span>{node.status}</span>
      <span>{(node.memoryBytes / 1024 / 1024).toFixed(1)} MB</span>
      {node.pid === listenerPid && <b>LISTENER</b>}
    </div>
    {node.children.length > 0 && <ul>{node.children.map((child) => <ProcessTreeNode key={child.pid} node={child} listenerPid={listenerPid} />)}</ul>}
  </li>;
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("tatas-theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [ports, setPorts] = useState<PortProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("ports");
  const [showInternal, setShowInternal] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [selectedPids, setSelectedPids] = useState<number[]>([]);
  const [trees, setTrees] = useState<Record<number, ProcessNode | null>>({});
  const [treeLoading, setTreeLoading] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Record<number, ProcessMetric>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [reservations, setReservations] = useState<PortReservation[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("tatas-port-reservations") ?? "[]") as PortReservation[];
    } catch {
      return [];
    }
  });
  const handledCollisions = useRef(new Set<string>());

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPorts(await invoke<PortProcess[]>("scan_active_ports"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const ownerKey = (item: Pick<PortProcess, "cwd" | "projectName">) =>
    (item.projectName ?? item.cwd ?? "unknown").replace(/[\\/]+$/, "").toLocaleLowerCase();

  const reservePort = (item: PortProcess) => {
    const existing = reservations.find((reservation) => reservation.port === item.port);
    if (existing && ownerKey(existing) === ownerKey(item)) {
      setReservations((current) => current.filter((reservation) => reservation.port !== item.port));
      setActionMessage(`Port ${item.port} is no longer reserved.`);
      return;
    }
    if (existing && !window.confirm(`Replace the existing reservation for port ${item.port}?`)) return;
    const reservation: PortReservation = {
      port: item.port,
      projectName: item.projectName ?? item.processName,
      cwd: item.cwd,
      autoKill: false,
    };
    setReservations((current) => [...current.filter((entry) => entry.port !== item.port), reservation]);
    setActionMessage(`Port ${item.port} is now reserved for ${reservation.projectName}.`);
  };

  const killOne = async (item: PortProcess) => {
    if (!window.confirm(`Kill ${item.processName} (PID ${item.pid}) and its child processes?`)) return;
    const result = await invoke<KillResult>("kill_process", { pid: item.pid, killPid: item.killPid });
    setActionMessage(result.message || (result.killed ? `PID ${item.pid} was stopped` : `Failed to stop PID ${item.pid}`));
    await scan();
  };

  const workspaceKey = (item: PortProcess) => item.cwd ?? `pid:${item.pid}`;
  const query = search.trim().toLocaleLowerCase();
  const filteredPorts = ports.filter((item) => {
    if (!query) return true;
    return [item.port, item.pid, item.address, item.processName, item.processType, item.framework, item.projectName, item.cwd]
      .filter((value) => value != null)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
  const visiblePorts = filteredPorts
    .filter((item) => showInternal || item.processType !== "Developer tool")
    .sort((left, right) =>
      (metrics[right.pid]?.memoryBytes ?? 0) - (metrics[left.pid]?.memoryBytes ?? 0)
      || left.port - right.port,
    );
  const portGroups = [
    {
      key: "developer",
      title: "Developer Processes",
      description: "Project runtime, editor, dan development tools",
      items: visiblePorts.filter((item) => item.processType !== "System"),
    },
    {
      key: "system",
      title: "System Processes",
      description: "Windows services and processes without a project workspace",
      items: visiblePorts.filter((item) => item.processType === "System"),
    },
  ];
  const isGroupOpen = (key: string, itemCount: number) => Boolean(expandedGroups[key]) || Boolean(query && itemCount);
  const toggleGroup = (key: string) => setExpandedGroups((current) => ({ ...current, [key]: !current[key] }));
  const toggleSelection = (pid: number) => setSelectedPids((current) =>
    current.includes(pid) ? current.filter((selected) => selected !== pid) : [...current, pid],
  );

  const killSelected = async () => {
    const selectedItems = ports.filter((item) => selectedPids.includes(item.pid));
    const targets = Array.from(
      new Map(selectedItems.map((item) => [item.killPid, { pid: item.pid, killPid: item.killPid }])).values(),
    );
    if (!targets.length || !window.confirm(`Kill the ${targets.length} selected process trees?`)) return;
    try {
      const results = await invoke<KillResult[]>("kill_workspace", { targets });
      const killed = results.filter((result) => result.killed).length;
      setActionMessage(`${killed}/${results.length} process trees stopped successfully.`);
      setSelectedPids([]);
      await scan();
    } catch (reason) {
      setActionMessage(`Bulk kill failed: ${String(reason)}`);
    }
  };

  const toggleTree = async (pid: number) => {
    if (pid in trees) {
      setTrees((current) => {
        const next = { ...current };
        delete next[pid];
        return next;
      });
      return;
    }
    setTreeLoading(pid);
    try {
      const tree = await invoke<ProcessNode>("get_process_tree", { pid });
      setTrees((current) => ({ ...current, [pid]: tree }));
    } catch (reason) {
      setActionMessage(`Failed to load process tree: ${String(reason)}`);
    } finally {
      setTreeLoading(null);
    }
  };

  const quickRestart = async (item: PortProcess) => {
    if (!item.restartCommand || !item.restartCwd) return;
    if (!window.confirm(`Restart PID ${item.pid} with “${item.restartCommand}”?`)) return;
    try {
      const result = await invoke<RestartResult>("quick_restart", {
        pid: item.pid, killPid: item.killPid, cwd: item.restartCwd, command: item.restartCommand,
      });
      setActionMessage(`${result.command} restarted (launcher PID ${result.spawnedPid}).`);
      window.setTimeout(() => void scan(), 1200);
    } catch (reason) {
      setActionMessage(`Quick restart failed: ${String(reason)}`);
    }
  };
  const workspaces = Object.entries(
    filteredPorts.filter((item) => item.processType === "Project runtime").reduce<Record<string, PortProcess[]>>((groups, item) => {
      (groups[workspaceKey(item)] ??= []).push(item);
      return groups;
    }, {}),
  );

  const killGroup = async (name: string, items: PortProcess[]) => {
    const targets = items.map((item) => ({ pid: item.pid, killPid: item.killPid }));
    const processCount = new Set(targets.map((target) => target.killPid)).size;
    if (!window.confirm(`Kill workspace ${name} (${processCount} process tree)?`)) return;
    const results = await invoke<KillResult[]>("kill_workspace", { targets });
    const killed = results.filter((result) => result.killed).length;
    setActionMessage(`${killed}/${results.length} process trees stopped successfully.`);
    await scan();
  };

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("tatas-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("tatas-port-reservations", JSON.stringify(reservations));
  }, [reservations]);

  // Lightweight background discovery keeps reservations useful even when the
  // user does not manually press Scan again.
  useEffect(() => {
    let active = true;
    let busy = false;
    const monitor = async () => {
      if (busy) return;
      busy = true;
      try {
        const latest = await invoke<PortProcess[]>("scan_active_ports");
        if (active) setPorts(latest);
      } catch {
        // The visible manual scan remains responsible for presenting errors.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void monitor(), 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!ports.length) return;
    let active = true;
    const refreshMetrics = async () => {
      try {
        const values = await invoke<ProcessMetric[]>("get_process_metrics", { pids: [...new Set(ports.map((item) => item.pid))] });
        if (active) setMetrics(Object.fromEntries(values.map((metric) => [metric.pid, metric])));
      } catch (reason) {
        if (active) setActionMessage(`Failed to refresh metrics: ${String(reason)}`);
      }
    };
    void refreshMetrics();
    const timer = window.setInterval(() => void refreshMetrics(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ports]);

  const collisions = reservations.reduce<PortCollision[]>((result, reservation) => {
    const exactIntruders = ports
      .filter((item) => item.port === reservation.port && ownerKey(item) !== ownerKey(reservation))
      .map((intruder) => ({ reservation, intruder, kind: "hijack" as const }));
    if (exactIntruders.length) {
      result.push(...exactIntruders);
      return result;
    }

    // Vite automatically moves to the next free port, so the failed bind is
    // no longer visible in the socket table. Detect its conventional fallback
    // range only while the reserved owner is still active on the original port.
    const ownerIsActive = ports.some((item) => item.port === reservation.port && ownerKey(item) === ownerKey(reservation));
    if (!ownerIsActive) return result;
    const fallbacks = ports
      .filter((item) =>
        item.framework === "Vite"
        && ownerKey(item) !== ownerKey(reservation)
        && item.port > reservation.port
        && item.port <= reservation.port + 10,
      )
      .map((intruder) => ({ reservation, intruder, kind: "vite-fallback" as const }));
    result.push(...fallbacks);
    return result;
  }, []);

  useEffect(() => {
    for (const { reservation, intruder, kind } of collisions) {
      const collisionKey = `${reservation.port}:${intruder.pid}:${kind}`;
      if (handledCollisions.current.has(collisionKey)) continue;
      handledCollisions.current.add(collisionKey);
      const message = kind === "vite-fallback"
        ? `${intruder.projectName ?? intruder.processName} could not use reserved port ${reservation.port} and appears to have fallen back to port ${intruder.port}.`
        : `${intruder.processName} (PID ${intruder.pid}) is using port ${reservation.port}, reserved for ${reservation.projectName}.`;
      setActionMessage(`${kind === "vite-fallback" ? "Vite port fallback" : "Port collision"}: ${message}`);

      void notifyCollision(message, kind === "vite-fallback" ? "Tatas Killer: Vite port fallback" : undefined).catch(() => {
        // The in-app collision banner remains available if OS notifications fail.
      });

      if (reservation.autoKill && kind === "hijack") {
        void invoke<KillResult>("kill_process", { pid: intruder.pid, killPid: intruder.killPid })
          .then((result) => setActionMessage(result.killed ? `Blocked intruder on port ${reservation.port}.` : result.message))
          .then(() => scan())
          .catch((reason) => setActionMessage(`Auto-kill failed: ${String(reason)}`));
      }
    }
  }, [collisions, scan]);

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><span>TK</span><strong>Tatas Killer</strong></div>
        <nav>
          <button className={view === "ports" ? "active" : ""} onClick={() => setView("ports")}>Ports <b>{visiblePorts.length}</b></button>
          <button className={view === "workspaces" ? "active" : ""} onClick={() => setView("workspaces")}>Workspaces <b>{workspaces.length}</b></button>
          <button className={view === "reservations" ? "active" : ""} onClick={() => setView("reservations")}>Reserved <b>{reservations.length}</b></button>
          <button className={view === "zombies" ? "active" : ""} onClick={() => setView("zombies")}>Zombies <b>{ports.filter((p) => p.isZombie).length}</b></button>
        </nav>
        <div className="sidebar-footer">
          <button className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            <i>{theme === "dark" ? "SUN" : "MOON"}</i>
          </button>
          <p>Tatas &middot; complete &amp; clean</p>
        </div>
      </aside>
      <main>
      <header>
        <div>
          <p className="eyebrow">Local port &amp; process manager</p>
          <h1>{view === "ports" ? "Active Ports" : view === "workspaces" ? "Workspaces" : view === "reservations" ? "Port Reservations" : "Zombie Processes"}</h1>
        </div>
        <div className="header-actions">
          <div className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search port, PID, project…" aria-label="Search processes or ports" />
            {search && <button className="clear-search" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
          </div>
          <label><input type="checkbox" checked={showInternal} onChange={(event) => setShowInternal(event.target.checked)} /> Show internal tools</label>
          <button className="scan-button" onClick={() => void scan()} disabled={loading}>{loading ? "Scanning…" : "Scan again"}</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {actionMessage && <p className="notice">{actionMessage}</p>}
      {collisions.length > 0 && <div className="collision-alert">
        <strong>{collisions.length} port conflict{collisions.length > 1 ? "s" : ""} detected</strong>
        <span>Review the Reserved Ports section for ownership details.</span>
      </div>}
      {view === "ports" && <div className="bulk-toolbar">
        <button onClick={() => setSelectedPids([...new Set(visiblePorts.map((item) => item.pid))])}>Select all results</button>
        {selectedPids.length > 0 && <>
          <span>{selectedPids.length} processes selected</span>
          <button onClick={() => setSelectedPids([])}>Clear selection</button>
          <button className="kill bulk-kill" onClick={() => void killSelected()}>Kill selected</button>
        </>}
      </div>}
      {!loading && !error && ports.length === 0 && (
        <p className="empty">No TCP listening ports found.</p>
      )}

      {view === "ports" && <section className="port-groups" aria-live="polite">
        {portGroups.map((group) => <section className="process-group" key={group.key}>
          <button className="group-header" onClick={() => toggleGroup(group.key)} aria-expanded={isGroupOpen(group.key, group.items.length)}>
            <div><h2>{group.title}</h2><p>{group.description}</p></div>
            <div className="group-summary"><span>{group.items.length} listener</span><i>{isGroupOpen(group.key, group.items.length) ? "⌃" : "⌄"}</i></div>
          </button>
          {isGroupOpen(group.key, group.items.length) && <div className="port-list">
          {group.items.map((item) => (
          <article
            className="port-card port-card-clickable"
            key={`${item.pid}-${item.address}-${item.port}`}
            tabIndex={0}
            title="Klik untuk membuka process tree"
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest("button, input, label, .process-tree")) void toggleTree(item.pid);
            }}
            onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) void toggleTree(item.pid); }}
          >
            <label className="process-select" title={`Select PID ${item.pid}`}>
              <input type="checkbox" checked={selectedPids.includes(item.pid)} onChange={() => toggleSelection(item.pid)} />
            </label>
            <span className="port">:{item.port}</span>
            <div className="details">
              <strong>{item.framework ? `${item.framework} — ` : ""}{item.projectName ?? item.processName}</strong>
              <span title={item.cwd ?? undefined}>{item.cwd ?? "CWD is unavailable"}</span>
            </div>
            <div className="meta">
              <span>{item.address}</span>
              <span>PID {item.pid}</span>
              {item.killPid !== item.pid && <span>via runtime PID {item.killPid}</span>}
            </div>
            <div className="badges"><span className="type">{item.processType}</span><span className={`status ${item.isZombie ? "danger" : ""}`}>{item.status}</span></div>
            <div className="resource-usage" title="Listener and its child processes">
              <span>CPU <b>{metrics[item.pid]?.cpuPercent.toFixed(1) ?? "0.0"}%</b></span>
              <span>RAM <b>{formatMemory(metrics[item.pid]?.memoryBytes ?? 0)}</b></span>
            </div>
            <div className="card-actions">
              {treeLoading === item.pid && <span className="tree-loading">Loading tree...</span>}
              <button className={reservations.some((entry) => entry.port === item.port && ownerKey(entry) === ownerKey(item)) ? "pin pinned" : "pin"} onClick={() => reservePort(item)}>
                {reservations.some((entry) => entry.port === item.port && ownerKey(entry) === ownerKey(item)) ? "Unpin" : "Pin port"}
              </button>
              {item.restartCommand && <button className="restart" onClick={() => void quickRestart(item)} title={`${item.restartCommand} · ${item.restartCwd}`}>Restart</button>}
              <button className="kill" onClick={() => void killOne(item)}>Kill</button>
            </div>
            {trees[item.pid] && <div className="process-tree"><ul><ProcessTreeNode node={trees[item.pid]!} listenerPid={item.pid} /></ul></div>}
          </article>
          ))}
          {group.items.length === 0 && <p className="group-empty">No listeners in this group.</p>}
          </div>}
        </section>)}
      </section>}

      {view === "zombies" && <section className="port-list" aria-live="polite">
        {filteredPorts.filter((item) => item.isZombie).map((item) => (
          <article className="port-card port-card-clickable" key={`${item.pid}-${item.address}-${item.port}`} tabIndex={0} onClick={(event) => {
            if (!(event.target as HTMLElement).closest("button, input, label, .process-tree")) void toggleTree(item.pid);
          }} onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) void toggleTree(item.pid); }}>
            <label className="process-select" title={`Select PID ${item.pid}`}><input type="checkbox" checked={selectedPids.includes(item.pid)} onChange={() => toggleSelection(item.pid)} /></label>
            <span className="port">:{item.port}</span>
            <div className="details"><strong>{item.framework ? `${item.framework} — ` : ""}{item.projectName ?? item.processName}</strong><span>{item.cwd ?? "CWD is unavailable"}</span></div>
            <div className="meta"><span>{item.address}</span><span>PID {item.pid}</span></div>
            <div className="badges"><span className="type">{item.processType}</span><span className="status danger">{item.status}</span></div>
            <div className="card-actions"><button className="kill" onClick={() => void killOne(item)}>Kill</button></div>
            {trees[item.pid] && <div className="process-tree"><ul><ProcessTreeNode node={trees[item.pid]!} listenerPid={item.pid} /></ul></div>}
          </article>
        ))}
        {!filteredPorts.some((item) => item.isZombie) && <p className="empty">No matching zombie processes.</p>}
      </section>}

      {view === "workspaces" && <section className="workspace-list">
        {workspaces.map(([key, items]) => {
          const label = items[0].projectName ?? items[0].processName;
          const uniqueItems = [...new Map(items.map((item) => [item.pid, item])).values()];
          const workspaceCpu = uniqueItems.reduce((total, item) => total + (metrics[item.pid]?.cpuPercent ?? 0), 0);
          const workspaceMemory = uniqueItems.reduce((total, item) => total + (metrics[item.pid]?.memoryBytes ?? 0), 0);
          return <article className="workspace-card" key={key}>
            <div><strong>{label}</strong><span>{key.startsWith("pid:") ? "CWD is unavailable" : key}</span></div>
            <span>{new Set(items.map((item) => item.pid)).size} PID · {items.length} port</span>
            <span className="workspace-metrics">CPU {workspaceCpu.toFixed(1)}% · RAM {formatMemory(workspaceMemory)}</span>
            <button className="kill" onClick={() => void killGroup(label, items)}>Kill workspace</button>
          </article>;
        })}
      </section>}

      {view === "reservations" && <section className="reservation-list">
        {reservations.map((reservation) => {
          const activeOwner = ports.find((item) => item.port === reservation.port && ownerKey(item) === ownerKey(reservation));
          const collision = collisions.find((entry) => entry.reservation.port === reservation.port);
          return <article className={`reservation-card ${collision ? "has-collision" : ""}`} key={reservation.port}>
            <span className="reserved-port">:{reservation.port}</span>
            <div className="reservation-owner"><strong>{reservation.projectName}</strong><span title={reservation.cwd ?? undefined}>{reservation.cwd ?? "Workspace path unavailable"}</span></div>
            <span className={`reservation-state ${collision ? "danger" : activeOwner ? "online" : "idle"}`}>{collision ? collision.kind === "vite-fallback" ? "Vite fallback" : "Collision" : activeOwner ? "Owner active" : "Waiting"}</span>
            <label className="auto-kill-toggle"><input type="checkbox" checked={reservation.autoKill} onChange={(event) => {
              const enabled = event.target.checked;
              if (enabled && !window.confirm(`Automatically kill any process that hijacks port ${reservation.port}?`)) return;
              setReservations((current) => current.map((entry) => entry.port === reservation.port ? { ...entry, autoKill: enabled } : entry));
            }} /> Auto-kill intruders</label>
            <button onClick={() => setReservations((current) => current.filter((entry) => entry.port !== reservation.port))}>Remove</button>
            {collision && <p>{collision.kind === "vite-fallback"
              ? <><strong>{collision.intruder.projectName ?? collision.intruder.processName}</strong> moved to port {collision.intruder.port} after the reserved port was unavailable.</>
              : <><strong>{collision.intruder.processName}</strong> (PID {collision.intruder.pid}) currently owns this reserved port.</>}
            </p>}
          </article>;
        })}
        {reservations.length === 0 && <p className="empty">No reserved ports yet. Open Active Ports and select Pin port.</p>}
      </section>}
      </main>
    </div>
  );
}

export default App;
