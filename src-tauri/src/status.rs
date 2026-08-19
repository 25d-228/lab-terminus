use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct MemoryStatus {
    pub total: i64,
    pub used: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DiskStatus {
    pub m: String,
    pub size: i64,
    pub used: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GpuStatus {
    pub index: i64,
    pub name: String,
    pub mu: i64,
    pub mt: i64,
    pub util: i64,
    pub temp: i64,
    pub pow: f64,
    pub plim: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GpuProcessStatus {
    pub pid: i64,
    pub gpu: i64,
    pub mem: i64,
    pub user: String,
    pub etime: String,
    pub cmd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct NetworkStatus {
    pub available: bool,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub uptime_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TopProcessStatus {
    pub pid: i64,
    pub user: String,
    pub cpu_pct: f64,
    pub memory_pct: f64,
    pub resident_bytes: u64,
    pub elapsed: String,
    pub command: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct HostStatus {
    pub id: String,
    pub online: bool,
    pub error: Option<String>,
    pub host: String,
    pub up: String,
    pub load: [f64; 3],
    pub ncpu: i64,
    pub mem: MemoryStatus,
    pub disks: Vec<DiskStatus>,
    pub gpus: Vec<GpuStatus>,
    pub procs: Vec<GpuProcessStatus>,
    pub network: NetworkStatus,
    pub top_procs: Vec<TopProcessStatus>,
}
