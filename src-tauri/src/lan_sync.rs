use std::{sync::{Arc, Mutex}, thread, net::UdpSocket};
use serde_json::{json, Value};
use tauri::State;
use tiny_http::{Header, Method, Response, Server};
use crate::storage::KvState;
use rusqlite::{Connection, OptionalExtension};

#[derive(Default)]
pub struct LanHost(pub Mutex<Option<Arc<Server>>>, pub Mutex<Option<crate::lan_discovery::Discovery>>);
fn read(db: &Connection) -> Result<Value, String> {
    let value: Option<String> = db.query_row("SELECT value FROM kv_store WHERE key='lan_transport'", [], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    serde_json::from_str(value.as_deref().unwrap_or("{}")).map_err(|e| e.to_string())
}
fn save(db: &Connection, value: &Value) -> Result<(), String> {
    db.execute("INSERT INTO kv_store(key,value) VALUES ('lan_transport',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [value.to_string()]).map_err(|e| e.to_string())?; Ok(())
}
fn addresses() -> Vec<String> {
    // Selecting a route does not transmit a packet or require Internet connectivity.
    UdpSocket::bind("0.0.0.0:0").ok().and_then(|socket| {
        socket.connect("192.168.1.1:80").ok()?;
        Some(format!("http://{}:5192", socket.local_addr().ok()?.ip()))
    }).into_iter().collect()
}
#[tauri::command]
pub async fn tipsy_lan_control(action: String, payload: Value, kv: State<'_, KvState>, host: State<'_, LanHost>) -> Result<Value, String> {
    let mut listener = host.0.lock().map_err(|e| e.to_string())?;
    let db = kv.0.lock().map_err(|e| e.to_string())?;
    let mut data = read(&db)?;
    match action.as_str() {
        "start" => {
            if !data["secret"].is_null() && data["secret"] != payload["secret"] {
                data["queue"] = json!([]); data.as_object_mut().unwrap().remove("incoming"); data.as_object_mut().unwrap().remove("outgoing");
                data.as_object_mut().unwrap().remove("lastIncomingIv");
            }
            if listener.is_none() {
                let server = Arc::new(Server::http("0.0.0.0:5192").map_err(|e| format!("无法开启局域网连接：{e}"))?);
                let worker = server.clone(); let database = kv.0.clone();
                thread::Builder::new().name("lan-sync".into()).spawn(move || {
                    for mut request in worker.incoming_requests() {
                        let result = (|| -> Result<(u16, Value), String> {
                            // Native HTTP carries the app origin even though it runs outside the WebView.
                            if request.headers().iter().any(|h| h.field.equiv("Origin") && !matches!(h.value.as_str(),
                                "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "http://localhost:5179" | "http://127.0.0.1:5179")) {
                                return Ok((403, json!({"error":"请求来源不受支持，请通过微醺屿应用进行同步"})));
                            }
                            let mut body = String::new();
                            if request.method() == &Method::Post { request.as_reader().read_to_string(&mut body).map_err(|e| e.to_string())?; }
                            let db = database.lock().map_err(|e| e.to_string())?;
                            let mut state = read(&db)?;
                            let authorization = format!("Bearer {}", state["token"].as_str().unwrap_or(""));
                            if state["enabled"] != true || !request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == authorization) {
                                return Ok((401, json!({"error":"配对码不正确或连接已关闭"})));
                            }
                            match (request.method(), request.url()) {
                                (&Method::Get, "/hello") => Ok((200, json!({"deviceId":state["deviceId"],"name":state["name"],"protocol":2,"packetId":state["outgoing"]["iv"]}))),
                                (&Method::Post, "/exchange") => {
                                    let packet: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
                                    if state["lastIncomingIv"] != packet["iv"] {
                                        if !state["queue"].is_array() { state["queue"] = json!([]); }
                                        let incoming_id = packet["iv"].clone();
                                        state["lastIncomingIv"] = incoming_id.clone();
                                        state["queue"].as_array_mut().unwrap().push(json!({"id":incoming_id,"packet":packet}));
                                        save(&db, &state)?;
                                    }
                                    Ok((200, json!({"packet":state["outgoing"]})))
                                },
                                _ => Ok((404, json!({"error":"Not Found"}))),
                            }
                        })();
                        let (code, value) = result.unwrap_or_else(|error| (500, json!({"error":error})));
                        let _ = request.respond(Response::from_string(value.to_string()).with_status_code(code)
                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()));
                    }
                }).map_err(|e| e.to_string())?;
                *listener = Some(server);
            }
            data["deviceId"] = payload["deviceId"].clone(); data["name"] = payload["name"].clone();
            data["secret"] = payload["secret"].clone(); data["token"] = payload["token"].clone(); data["enabled"] = json!(true); save(&db, &data)?;
            let identity = json!({"deviceId":data["deviceId"],"name":data["name"]});
            let mut discovery = host.1.lock().map_err(|e| e.to_string())?;
            if let Some(current) = discovery.as_ref() { current.update(identity); }
            else { *discovery = Some(crate::lan_discovery::Discovery::start(identity)?); }
        },
        "stop" => {
            data["enabled"] = json!(false); save(&db, &data)?;
            host.1.lock().map_err(|e| e.to_string())?.take();
            if let Some(server) = listener.take() { server.unblock(); }
        },
        "publish" => { if data["outgoing"]["iv"] != payload["packet"]["iv"] { data["outgoing"] = payload["packet"].clone(); save(&db, &data)?; } },
        "ack" => { if let Some(items) = data["queue"].as_array_mut() { items.retain(|item| item["id"] != payload["id"]); } if data["incoming"]["id"] == payload["id"] { data.as_object_mut().unwrap().remove("incoming"); } save(&db, &data)?; },
        "revoke" => { data["queue"] = json!([]); data.as_object_mut().unwrap().remove("incoming"); data.as_object_mut().unwrap().remove("outgoing"); data.as_object_mut().unwrap().remove("lastIncomingIv"); data["secret"] = payload["secret"].clone(); data["token"] = payload["token"].clone(); save(&db, &data)?; },
        _ => {},
    }
    data["enabled"] = json!(listener.is_some() && data["enabled"] == true);
    data["addresses"] = json!(addresses());
    data["nearby"] = json!(host.1.lock().map_err(|e| e.to_string())?.as_ref().map(|d| d.list()).unwrap_or_default());
    data.as_object_mut().unwrap().remove("outgoing");
    Ok(data)
}
