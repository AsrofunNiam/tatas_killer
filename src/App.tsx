import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
type View = "ports" | "workspaces" | "zombies";
type Theme = "dark" | "light";
type ProcessNode = { pid: number; name: string; status: string; memoryBytes: number; children: ProcessNode[] };
type RestartResult = { killedPid: number; spawnedPid: number; command: string };
type ProcessMetric = { pid: number; cpuPercent: number; memoryBytes: number };

const formatMemory = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

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
  const displayPriority = (item: PortProcess) => {
    const project = item.projectName?.toLocaleLowerCase();
    const framework = item.framework?.toLocaleLowerCase();
    if (project === "dwidaya-micro-service-gateway" && framework === "gin") return 0;
    if (project === "tatas_killer" && framework === "vite") return 1;
    return 2;
  };
  const visiblePorts = filteredPorts
    .filter((item) => showInternal || item.processType !== "Developer tool")
    .sort((left, right) => displayPriority(left) - displayPriority(right) || left.port - right.port);
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

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><span>TK</span><strong>Tatas Killer</strong></div>
        <nav>
          <button className={view === "ports" ? "active" : ""} onClick={() => setView("ports")}>Ports <b>{visiblePorts.length}</b></button>
          <button className={view === "workspaces" ? "active" : ""} onClick={() => setView("workspaces")}>Workspaces <b>{workspaces.length}</b></button>
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
          <h1>{view === "ports" ? "Active Ports" : view === "workspaces" ? "Workspaces" : "Zombie Processes"}</h1>
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
      </main>
    </div>
  );
}

export default App;
