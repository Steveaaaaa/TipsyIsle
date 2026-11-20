use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex}};
use tauri::State;

pub struct KvState(pub Arc<Mutex<Connection>>);
impl KvState {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }
}
#[tauri::command]
pub async fn tipsy_kv_get(key: Option<String>, keys: Option<Vec<String>>, state: State<'_, KvState>) -> Result<Value, String> {
    let connection = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = connection.lock().map_err(|e| e.to_string())?;
        if let Some(keys) = keys {
            let mut statement = connection.prepare_cached("SELECT value FROM kv_store WHERE key=?1").map_err(|e| e.to_string())?;
            let mut values = serde_json::Map::new();
            for key in keys {
                let value: Option<String> = statement.query_row([&key], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
                values.insert(key, value.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string())).transpose()?.unwrap_or(Value::Null));
            }
            return Ok(Value::Object(values));
        }
        let key = key.ok_or("缺少读取键")?;
        let value: Option<String> = connection.query_row(
            "SELECT value FROM kv_store WHERE key=?1", [key], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        value.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string())).unwrap_or(Ok(Value::Null))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn tipsy_kv_set_many(values: HashMap<String, Value>, state: State<'_, KvState>) -> Result<(), String> {
    let connection = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = connection.lock().map_err(|e| e.to_string())?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        {
            let mut statement = transaction.prepare_cached(
                "INSERT INTO kv_store(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ).map_err(|e| e.to_string())?;
            for (key, value) in values {
                statement.execute(params![key, serde_json::to_string(&value).map_err(|e| e.to_string())?])
                    .map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
