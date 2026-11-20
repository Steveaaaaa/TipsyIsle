use std::{collections::HashMap, net::UdpSocket, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde_json::{json, Value};

pub struct Discovery { alive: Arc<AtomicBool>, identity: Arc<Mutex<Value>>, devices: Arc<Mutex<HashMap<String, (Instant, Value)>>>, worker: Option<thread::JoinHandle<()>> }
impl Discovery {
    pub fn start(identity: Value) -> Result<Self, String> {
        let socket = UdpSocket::bind("0.0.0.0:5193").map_err(|e| e.to_string())?;
        socket.set_broadcast(true).map_err(|e| e.to_string())?;
        socket.set_read_timeout(Some(Duration::from_millis(400))).map_err(|e| e.to_string())?;
        let alive = Arc::new(AtomicBool::new(true)); let identity = Arc::new(Mutex::new(identity));
        let devices = Arc::new(Mutex::new(HashMap::new()));
        let (flag, info, found) = (alive.clone(), identity.clone(), devices.clone());
        let worker = thread::Builder::new().name("lan-discovery".into()).spawn(move || {
            let mut last = Instant::now() - Duration::from_secs(5); let mut buffer = [0u8; 2048];
            while flag.load(Ordering::Relaxed) {
                let own = info.lock().unwrap().clone();
                let packet = |query| json!({"service":"tipsy-isle-lan","protocol":1,"deviceId":own["deviceId"],"name":own["name"],"port":5192,"query":query}).to_string();
                if last.elapsed() >= Duration::from_secs(4) { let _ = socket.send_to(packet(true).as_bytes(), "255.255.255.255:5193"); last = Instant::now(); }
                if let Ok((size, source)) = socket.recv_from(&mut buffer) {
                    let Ok(value) = serde_json::from_slice::<Value>(&buffer[..size]) else { continue };
                    if value["service"] != "tipsy-isle-lan" || value["protocol"] != 1 || value["deviceId"] == own["deviceId"] { continue; }
                    if let Some(id) = value["deviceId"].as_str() {
                        found.lock().unwrap().insert(id.to_owned(), (Instant::now(), json!({"deviceId":id,"name":value["name"],"address":format!("http://{}:{}",source.ip(),value["port"].as_u64().unwrap_or(5192)),"seen":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64})));
                        if value["query"] == true { let _ = socket.send_to(packet(false).as_bytes(), source); }
                    }
                }
            }
        }).map_err(|e| e.to_string())?;
        Ok(Self { alive, identity, devices, worker: Some(worker) })
    }
    pub fn update(&self, value: Value) { *self.identity.lock().unwrap() = value; }
    pub fn list(&self) -> Vec<Value> { self.devices.lock().unwrap().values().filter(|(seen, _)| seen.elapsed() < Duration::from_secs(16)).map(|(_, item)| item.clone()).collect() }
}
impl Drop for Discovery { fn drop(&mut self) { self.alive.store(false, Ordering::Relaxed); if let Some(worker) = self.worker.take() { let _ = worker.join(); } } }
