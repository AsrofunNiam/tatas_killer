use serde::Serialize;
use std::{collections::{BTreeMap, BTreeSet, HashMap}, fs, path::Path, sync::{Arc, Mutex}};
use sysinfo::{Pid, System};

/// Satu TCP endpoint yang sedang berada dalam status LISTENING.
/// Nama field otomatis dikirim sebagai camelCase agar nyaman dipakai di React.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortProcess {
    pid: u32,
    kill_pid: u32,
    port: u16,
    address: String,
    process_name: String,
    process_type: String,
    framework: Option<String>,
    restart_command: Option<String>,
    restart_cwd: Option<String>,
    status: String,
    is_zombie: bool,
    cwd: Option<String>,
    project_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KillResult {
    pid: u32,
    killed: bool,
    message: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillTarget {
    pid: u32,
    kill_pid: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessNode {
    pid: u32,
    name: String,
    status: String,
    memory_bytes: u64,
    children: Vec<ProcessNode>,
}

#[derive(serde::Deserialize)]
struct PackageJson {
    name: Option<String>,
    #[serde(default)]
    scripts: HashMap<String, String>,
}

struct ProjectInfo {
    name: Option<String>,
    framework: Option<String>,
    process_type: String,
    restart_command: Option<String>,
    restart_cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestartResult {
    killed_pid: u32,
    spawned_pid: u32,
    command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMetric {
    pid: u32,
    cpu_percent: f32,
    memory_bytes: u64,
}

struct MetricsState {
    system: Arc<Mutex<System>>,
}

impl Default for MetricsState {
    fn default() -> Self {
        Self { system: Arc::new(Mutex::new(System::new_all())) }
    }
}

/// Membaca nama project tanpa menganggap package.json selalu valid/tersedia.
fn read_package_name(cwd: &Path) -> Option<String> {
    let contents = fs::read_to_string(cwd.join("package.json")).ok()?;
    serde_json::from_str::<PackageJson>(&contents).ok()?.name
}

/// Mencari manifest terdekat hingga root repository. Editor dan language server
/// diklasifikasikan terlebih dahulu agar tidak dianggap sebagai runtime project.
fn recognize_project(cwd: Option<&Path>, process_name: &str) -> ProjectInfo {
    let lower_process = process_name.to_ascii_lowercase();
    if matches!(lower_process.as_str(), "code.exe" | "code" | "cursor.exe" | "cursor") {
        return ProjectInfo {
            name: Some("VS Code Internal".into()),
            framework: None,
            process_type: "Developer tool".into(),
            restart_command: None,
            restart_cwd: None,
        };
    }

    let Some(cwd) = cwd else {
        return ProjectInfo { name: None, framework: None, process_type: "System".into(), restart_command: None, restart_cwd: None };
    };
    let mut manifest_name = None;
    let mut framework = None;
    let mut repository_name = None;
    let mut restart_command = None;
    let mut restart_cwd = None;

    for directory in cwd.ancestors().take(8) {
        if directory.join(".git").exists() {
            repository_name = directory.file_name().map(|name| name.to_string_lossy().into_owned());
        }
        if manifest_name.is_none() {
            if let Some(name) = read_package_name(directory) {
                let package = fs::read_to_string(directory.join("package.json")).unwrap_or_default();
                if let Ok(package_json) = serde_json::from_str::<PackageJson>(&package) {
                    if package_json.scripts.contains_key("dev") {
                        let manager = if directory.join("pnpm-lock.yaml").is_file() { "pnpm" } else if directory.join("yarn.lock").is_file() { "yarn" } else if directory.join("bun.lockb").is_file() || directory.join("bun.lock").is_file() { "bun" } else { "npm" };
                        restart_command = Some(format!("{manager} run dev"));
                        restart_cwd = Some(directory.to_string_lossy().into_owned());
                    }
                }
                framework = Some(if package.contains("\"next\"") { "Next.js" } else if package.contains("\"vite\"") { "Vite" } else if package.contains("@nestjs/") { "NestJS" } else { "Node.js" }.into());
                manifest_name = Some(name);
            } else if let Ok(go_mod) = fs::read_to_string(directory.join("go.mod")) {
                framework = Some(if go_mod.contains("github.com/gin-gonic/gin") { "Gin" } else { "Go" }.into());
                manifest_name = go_mod.lines().find_map(|line| line.strip_prefix("module ")).and_then(|module| module.rsplit('/').next()).map(str::to_owned);
                restart_command = Some("go run .".into());
                restart_cwd = Some(directory.to_string_lossy().into_owned());
            } else if directory.join("Cargo.toml").is_file() {
                framework = Some("Rust".into());
                manifest_name = directory.file_name().map(|name| name.to_string_lossy().into_owned());
            }
        }
    }

    ProjectInfo {
        name: repository_name.or(manifest_name),
        framework,
        process_type: "Project runtime".into(),
        restart_command,
        restart_cwd,
    }
}

/// Mengambil port dari local address netstat, termasuk format IPv6 `[::]:3000`.
fn parse_local_address(value: &str) -> Option<(String, u16)> {
    let (address, port) = value.rsplit_once(':')?;
    Some((address.trim_matches(['[', ']']).to_owned(), port.parse().ok()?))
}

/// `go run` menjalankan binary temporer sebagai child. Membunuh launcher go.exe
/// memberikan shutdown yang konsisten tanpa ikut mematikan terminal/VS Code.
fn runtime_kill_pid(system: &System, listener_pid: u32) -> u32 {
    let Some(process) = system.process(Pid::from_u32(listener_pid)) else { return listener_pid };
    let Some(parent_pid) = process.parent() else { return listener_pid };
    let Some(parent) = system.process(parent_pid) else { return listener_pid };
    let parent_name = parent.name().to_string_lossy().to_ascii_lowercase();
    let executable = process.exe().map(|path| path.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if parent_name == "go.exe" && executable.contains("\\temp\\go-build") {
        parent_pid.as_u32()
    } else {
        listener_pid
    }
}

fn is_process_boundary(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "powershell.exe" | "pwsh.exe" | "code.exe" | "cursor.exe" |
        "windowsterminal.exe" | "explorer.exe"
    )
}

fn process_tree_root(system: &System, listener_pid: Pid) -> Pid {
    let mut current = listener_pid;
    for _ in 0..12 {
        let Some(parent_pid) = system.process(current).and_then(|process| process.parent()) else { break };
        let Some(parent) = system.process(parent_pid) else { break };
        if is_process_boundary(&parent.name().to_string_lossy()) {
            break;
        }
        current = parent_pid;
    }
    current
}

fn build_process_node(system: &System, pid: Pid, depth: usize, remaining: &mut usize) -> Option<ProcessNode> {
    if depth > 10 || *remaining == 0 {
        return None;
    }
    let process = system.process(pid)?;
    *remaining -= 1;
    let mut child_pids: Vec<_> = system
        .processes()
        .iter()
        .filter_map(|(child_pid, child)| (child.parent() == Some(pid)).then_some(*child_pid))
        .collect();
    child_pids.sort_by_key(|child_pid| child_pid.as_u32());
    let children = child_pids
        .into_iter()
        .filter_map(|child_pid| build_process_node(system, child_pid, depth + 1, remaining))
        .collect();
    Some(ProcessNode {
        pid: pid.as_u32(),
        name: process.name().to_string_lossy().into_owned(),
        status: process.status().to_string(),
        memory_bytes: process.memory(),
        children,
    })
}

fn is_descendant_of(system: &System, candidate: Pid, root: Pid) -> bool {
    let mut current = candidate;
    for _ in 0..16 {
        if current == root {
            return true;
        }
        let Some(parent) = system.process(current).and_then(|process| process.parent()) else { return false };
        current = parent;
    }
    false
}

/// Mengagregasi listener dan seluruh child runtime-nya. System disimpan antar
/// pemanggilan karena CPU usage membutuhkan delta antara dua snapshot.
#[tauri::command]
async fn get_process_metrics(pids: Vec<u32>, state: tauri::State<'_, MetricsState>) -> Result<Vec<ProcessMetric>, String> {
    if pids.len() > 512 {
        return Err("A metrics refresh supports up to 512 PIDs".into());
    }
    let shared_system = Arc::clone(&state.system);
    tauri::async_runtime::spawn_blocking(move || {
        let mut system = shared_system.lock().map_err(|_| "The metrics state lock is corrupted".to_owned())?;
        system.refresh_all();
        let unique: BTreeSet<_> = pids.into_iter().collect();
        Ok(unique.into_iter().map(|pid| {
            let listener = Pid::from_u32(pid);
            let root = Pid::from_u32(runtime_kill_pid(&system, pid));
            let (cpu_percent, memory_bytes) = system.processes().iter()
                .filter(|(candidate, _)| is_descendant_of(&system, **candidate, root))
                .fold((0.0_f32, 0_u64), |(cpu, memory), (_, process)| {
                    (cpu + process.cpu_usage(), memory.saturating_add(process.memory()))
                });
            if system.process(listener).is_none() {
                ProcessMetric { pid, cpu_percent: 0.0, memory_bytes: 0 }
            } else {
                ProcessMetric { pid, cpu_percent, memory_bytes }
            }
        }).collect())
    }).await.map_err(|error| format!("Metrics task failed: {error}"))?
}

/// Snapshot tree dibuat hanya ketika user membuka panel agar scan port tetap ringan.
#[tauri::command]
async fn get_process_tree(pid: u32) -> Result<ProcessNode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let system = System::new_all();
        let listener_pid = Pid::from_u32(pid);
        if system.process(listener_pid).is_none() {
            return Err(format!("PID {pid} is no longer running"));
        }
        let root = process_tree_root(&system, listener_pid);
        let mut remaining = 200;
        build_process_node(&system, root, 0, &mut remaining)
            .ok_or_else(|| format!("Failed to build the process tree for PID {pid}"))
    })
    .await
    .map_err(|error| format!("Process tree task failed: {error}"))?
}

#[cfg(target_os = "windows")]
fn scan_windows_ports() -> Result<Vec<PortProcess>, String> {
    use std::process::{Command, Stdio};

    // Tidak memakai cmd.exe/PowerShell sehingga tidak ada input yang dapat
    // diinterpretasikan sebagai perintah shell.
    let output = Command::new("netstat.exe")
        // Do not use `-p tcp`: on Windows it can omit TCPv6 listeners such as
        // Vite's default `[::1]:5173`. The parser below already ignores UDP.
        .args(["-a", "-n", "-o"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Failed to run netstat.exe: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "netstat.exe exited with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // A dual-stack socket is often reported twice (`0.0.0.0` and `[::]`).
    // Treat PID + port as one logical listener and retain all bind addresses.
    let mut endpoints: BTreeMap<(u32, u16), BTreeSet<String>> = BTreeMap::new();

    for line in stdout.lines() {
        let columns: Vec<_> = line.split_whitespace().collect();
        // TCP <local> <remote> LISTENING <pid>
        if columns.len() < 5 || !columns[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !columns[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }

        if let (Some((address, port)), Ok(pid)) =
            (parse_local_address(columns[1]), columns[4].parse::<u32>())
        {
            endpoints.entry((pid, port)).or_default().insert(address);
        }
    }

    // Satu snapshot process table digunakan untuk seluruh PID, bukan refresh
    // per baris; ini jauh lebih murah saat banyak port sedang aktif.
    let system = System::new_all();
    Ok(endpoints
        .into_iter()
        .map(|((pid, port), addresses)| {
            let process = system.process(Pid::from_u32(pid));
            let cwd_path = process.and_then(|p| p.cwd());
            let status = process.map(|p| p.status().to_string()).unwrap_or_else(|| "Gone".into());
            let process_name = process
                .map(|p| p.name().to_string_lossy().into_owned())
                .unwrap_or_else(|| "Unknown process".into());
            let project = recognize_project(cwd_path, &process_name);
            PortProcess {
                pid,
                kill_pid: runtime_kill_pid(&system, pid),
                port,
                address: addresses.into_iter().collect::<Vec<_>>().join(", "),
                process_name,
                process_type: project.process_type,
                framework: project.framework,
                restart_command: project.restart_command,
                restart_cwd: project.restart_cwd,
                is_zombie: matches!(status.as_str(), "Zombie" | "Dead"),
                status,
                cwd: cwd_path.map(|path| path.to_string_lossy().into_owned()),
                project_name: project.name,
            }
        })
        .collect())
}

#[cfg(target_os = "windows")]
fn kill_windows_process(target: KillTarget) -> KillResult {
    use std::{process::{Command, Stdio}, thread, time::Duration};

    let pid = target.kill_pid;

    // PID 0/4 adalah proses inti Windows. PID aplikasi sendiri juga ditolak agar
    // UI tidak mematikan dirinya sebelum dapat melaporkan hasil operasi.
    if pid <= 4 || pid == std::process::id() {
        return KillResult {
            pid,
            killed: false,
            message: "This PID is protected and cannot be stopped".into(),
        };
    }

    let output = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output();

    match output {
        Ok(output) if output.status.success() => {
            // Exit code 0 dari taskkill belum menjamin listener child sudah hilang.
            thread::sleep(Duration::from_millis(700));
            let verification = System::new_all();
            let listener_gone = verification.process(Pid::from_u32(target.pid)).is_none();
            KillResult {
                pid: target.pid,
                killed: listener_gone,
                message: if listener_gone {
                    format!("Listener PID {} was stopped through runtime PID {pid}", target.pid)
                } else {
                    format!("taskkill completed, but listener PID {} is still running", target.pid)
                },
            }
        }
        Ok(output) => KillResult {
            pid,
            killed: false,
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        },
        Err(error) => KillResult {
            pid,
            killed: false,
            message: format!("Failed to run taskkill.exe: {error}"),
        },
    }
}

/// Mematikan satu process tree. Frontend wajib meminta konfirmasi pengguna.
#[tauri::command]
async fn kill_process(pid: u32, kill_pid: u32) -> Result<KillResult, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || kill_windows_process(KillTarget { pid, kill_pid }))
            .await
            .map_err(|error| format!("Kill task failed: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, kill_pid);
        Err("Process termination is currently available on Windows only".into())
    }
}

/// Mematikan kumpulan PID unik secara berurutan dan mengembalikan hasil tiap PID.
#[tauri::command]
async fn kill_workspace(targets: Vec<KillTarget>) -> Result<Vec<KillResult>, String> {
    if targets.len() > 256 {
        return Err("A workspace operation supports up to 256 PIDs".into());
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut seen = BTreeSet::new();
            targets
                .into_iter()
                .filter(|target| seen.insert(target.kill_pid))
                .map(kill_windows_process)
                .collect()
        })
        .await
        .map_err(|error| format!("Workspace kill task failed: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = targets;
        Err("Workspace termination is currently available on Windows only".into())
    }
}

#[cfg(target_os = "windows")]
fn restart_windows_process(target: KillTarget, cwd: String, command: String) -> Result<RestartResult, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};

    let allowed: &[&str] = &["npm run dev", "pnpm run dev", "yarn run dev", "bun run dev", "go run ."];
    if !allowed.contains(&command.as_str()) {
        return Err("The restart command is not an allowed preset".into());
    }
    let directory = fs::canonicalize(&cwd).map_err(|error| format!("Invalid restart directory: {error}"))?;
    if !directory.is_dir() {
        return Err("The restart directory is not a folder".into());
    }

    let kill_result = kill_windows_process(KillTarget { pid: target.pid, kill_pid: target.kill_pid });
    if !kill_result.killed {
        return Err(kill_result.message);
    }

    let parts: Vec<_> = command.split_whitespace().collect();
    let child = Command::new("cmd.exe")
        .arg("/K")
        .args(parts)
        .current_dir(directory)
        .stdin(Stdio::null())
        // CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE. Console dipertahankan
        // supaya log dev server tetap terlihat oleh developer.
        .creation_flags(0x0000_0200 | 0x0000_0010)
        .spawn()
        .map_err(|error| format!("Failed to run {command}: {error}"))?;

    Ok(RestartResult { killed_pid: target.pid, spawned_pid: child.id(), command })
}

#[tauri::command]
async fn quick_restart(pid: u32, kill_pid: u32, cwd: String, command: String) -> Result<RestartResult, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || restart_windows_process(KillTarget { pid, kill_pid }, cwd, command))
            .await
            .map_err(|error| format!("Quick restart task failed: {error}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, kill_pid, cwd, command);
        Err("Quick restart is currently available on Windows only".into())
    }
}

/// Command async mencegah pekerjaan OS yang blocking berjalan di UI thread.
#[tauri::command]
async fn scan_active_ports() -> Result<Vec<PortProcess>, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(scan_windows_ports)
            .await
            .map_err(|error| format!("Port scanner task failed: {error}"))?
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("This scanner is currently available on Windows only".to_owned())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MetricsState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_active_ports,
            kill_process,
            kill_workspace,
            get_process_tree,
            quick_restart,
            get_process_metrics
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
