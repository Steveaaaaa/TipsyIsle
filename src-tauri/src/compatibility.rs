use std::{sync::Arc, thread};
use tauri::{AppHandle, Runtime};
use tiny_http::{Header, Method, Response, Server};

pub struct CompatibilityHost { pub origin: String }
const CSP: &str = "default-src 'self' https: data: blob:; script-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; worker-src 'self' blob:; img-src 'self' https: data: blob:; frame-src 'self' https: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Only author assets live here. No application storage or model credentials. */
pub fn start<R: Runtime>(app: AppHandle<R>) -> Result<CompatibilityHost, Box<dyn std::error::Error>> {
    let server = Arc::new(Server::http(if cfg!(target_os = "android") { "127.0.0.1:5181" } else { "127.0.0.1:0" }).map_err(std::io::Error::other)?);
    let origin = format!("http://{}", server.server_addr());
    for index in 0..4 {
        let server = server.clone();
        let app = app.clone();
        thread::Builder::new().name(format!("author-assets-{index}")).spawn(move || {
            for request in server.incoming_requests() {
                if !matches!(request.method(), Method::Get | Method::Head) {
                    let _ = request.respond(Response::empty(405)); continue;
                }
                let path = request.url().split('?').next().unwrap_or("");
                let extension_file = path.strip_prefix("/scripts/extensions/third-party/").map(|name| ("packages", name))
                    .or_else(|| path.strip_prefix("/user/images/").map(|name| ("images", name)))
                    .or_else(|| path.strip_prefix("/user/files/").map(|name| ("files", name)));
                if let Some((area, name)) = extension_file {
                    let decoded = crate::gallery::decode_path(name);
                    let asset = decoded.as_deref().and_then(|name| crate::extension_files::file(&app, area, name).ok())
                        .filter(|path| path.is_file()).and_then(|path| std::fs::File::open(path).ok());
                    if let Some(file) = asset {
                        let mime = if area == "packages" { match name.rsplit('.').next().unwrap_or("") {
                            "js" | "mjs" => "text/javascript", "css" => "text/css", "html" => "text/html", "woff" => "font/woff", "woff2" => "font/woff2",
                            "wasm" => "application/wasm", _ => crate::gallery::mime(name),
                        }} else { match crate::gallery::mime(name) { "image/svg+xml" => "application/octet-stream", kind => kind } };
                        let mut response = Response::from_file(file);
                        for (key, value) in [("Content-Type", mime), ("Content-Security-Policy", CSP), ("X-Content-Type-Options", "nosniff"), ("Cache-Control", "no-cache")] {
                            response.add_header(Header::from_bytes(key, value).unwrap());
                        }
                        let _ = request.respond(response);
                    } else { let _ = request.respond(Response::empty(404)); }
                    continue;
                }
                if let Some(relative) = path.strip_prefix("/local-gallery/") {
                    let decoded = crate::gallery::decode_path(relative);
                    let asset = decoded.as_deref().and_then(|value| value.split_once('/')).and_then(|(story, name)| {
                        crate::gallery::file(&app, story, name).ok().and_then(|file| std::fs::File::open(file).ok()).map(|file| (file, name))
                    });
                    if let Some((file, name)) = asset {
                        let mut response = Response::from_file(file);
                        for (key, value) in [("Content-Type", crate::gallery::mime(name)), ("Access-Control-Allow-Origin", "*"),
                            ("X-Content-Type-Options", "nosniff"), ("Content-Security-Policy", CSP),
                            ("Cache-Control", if name == "manifest.json" { "no-store" } else { "public, max-age=31536000, immutable" })] {
                            response.add_header(Header::from_bytes(key, value).unwrap());
                        }
                        let _ = request.respond(response);
                    } else {
                        let response = Response::empty(404).with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());
                        let _ = request.respond(response);
                    }
                    continue;
                }
                let allowed = path == "/compat.html" || path == "/script.js"
                    || path.starts_with("/assets/") || path.starts_with("/scripts/");
                if !allowed || path.split('/').any(|part| part == "..") {
                    let _ = request.respond(Response::empty(404)); continue;
                }
                if let Some(asset) = app.asset_resolver().get(path.to_owned()) {
                    let data = if request.method() == &Method::Head { Vec::new() } else { asset.bytes };
                    let cache_control = if path == "/compat.html" { "no-store" } else { "no-cache" };
                    let mut response = Response::from_data(data);
                    for (name, value) in [("Content-Type", asset.mime_type.as_str()),
                        ("Content-Security-Policy", CSP), ("X-Content-Type-Options", "nosniff"),
                        ("Referrer-Policy", "no-referrer"), ("Cache-Control", cache_control)] {
                        response.add_header(Header::from_bytes(name, value).unwrap());
                    }
                    let _ = request.respond(response);
                } else { let _ = request.respond(Response::empty(404)); }
            }
        })?;
    }
    Ok(CompatibilityHost { origin })
}
