#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backend;
mod native;
mod job;
use backend::Backend;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl};
use base64::Engine;

const OPERATIONS: &[&str] = &["info","create","inferenceInfo","inferenceLoad","inferenceComplete","inferenceCancel","inferenceUnload","read","source","save","event","model","check","cancel","finish","exportProject","preview","exportBackup","importBackup","research","chooseCoder","projects","deleteProject","projectCommand","importProject"];
fn trusted(window: &WebviewWindow) -> Result<(),String> {
    let url = window.url().map_err(|e|e.to_string())?;
    if window.label() != "main" || !matches!(url.path(),"/Atlas-CHAT.html"|"/index.html") ||
        !(url.scheme() == "tauri" || (url.host_str() == Some("tauri.localhost") && matches!(url.scheme(),"http"|"https"))) { return Err("Untrusted Atlas caller".into()); }
    Ok(())
}
#[tauri::command]
async fn atlas_call(window: WebviewWindow, app: tauri::AppHandle, backend: tauri::State<'_,Arc<Backend>>, name: String, value: Option<Value>) -> Result<Value,String> {
    trusted(&window)?; let value = value.unwrap_or(Value::Null);
    if name == "windowAction" {
        match value.as_str().unwrap_or("") {
            "minimize" => window.minimize(), "toggleMaximize" => if window.is_maximized().map_err(|e|e.to_string())? { window.unmaximize() } else { window.maximize() },
            "close" => window.close(), "startDragging" => window.start_dragging(), _ => return Err("Unknown window action".into())
        }.map_err(|e|e.to_string())?; return Ok(json!(true));
    }
    if name == "migrationRead" {
        let data = app.path().app_data_dir().map_err(|e|e.to_string())?;
        let file = data_dir_override(data).join("electron-export.json");
        return match std::fs::read(&file) { Ok(data) => { if data.len() > 256*1024*1024 { return Err("Migration export too large".into()); } serde_json::from_slice(&data).map_err(|e|e.to_string()) }, Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(Value::Null), Err(e)=>Err(e.to_string()) };
    }
    if name == "poemCacheInfo" { return backend.call(&name,value).await; }
    if !OPERATIONS.contains(&name.as_str()) { return Err("Unknown Atlas operation".into()); }
    if name == "inferenceLoad" {
        let runtime = value["runtimeId"].as_str().unwrap_or("primary");
        if runtime != "primary" && !matches!(value["choice"].as_str(),Some("forge"|"firefly")) { return Err("Only lightweight models can use the secondary inference slot".into()); }
    }
    backend.call(&name,value).await
}
fn data_dir_override(default: PathBuf) -> PathBuf { std::env::var_os("ATLAS_TAURI_DATA_DIR").map(PathBuf::from).unwrap_or(default) }
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app,_,_| { if let Some(window)=app.get_webview_window("main") { let _=window.show();let _=window.set_focus(); } }))
        .register_asynchronous_uri_scheme_protocol("atlas-preview", |context, request, responder| {
            let app=context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let uri = request.uri().to_string();
                let result = async {
                    let url=url::Url::parse(&uri).map_err(|e|e.to_string())?;
                    let id=url.host_str().ok_or("Invalid preview address")?;
                    let file=url.path().trim_start_matches('/');
                    if id.len()!=36 || !id.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-') { return Err("Invalid project".into()); }
                    let backend=app.state::<Arc<Backend>>(); backend.call("_previewAsset",json!(format!("atlas-preview://{id}/{file}"))).await
                }.await;
                let mut response=tauri::http::Response::builder();
                let body=match result {
                    Ok(value) => { response=response.status(value["status"].as_u64().unwrap_or(404) as u16);
                        if let Some(headers)=value["headers"].as_object() { for (name,value) in headers { if let Some(value)=value.as_str() { response=response.header(name,value); } } }
                        base64::engine::general_purpose::STANDARD.decode(value["body"].as_str().unwrap_or("")).unwrap_or_default() }
                    Err(_) => {response=response.status(404); b"Preview unavailable".to_vec()}
                }; responder.respond(response.body(body).unwrap());
            });
        })
        .invoke_handler(tauri::generate_handler![atlas_call])
        .setup(|app| {
            let data=data_dir_override(app.path().app_data_dir()?); std::fs::create_dir_all(&data)?;
            let packaged=app.path().resource_dir()?;
            let resources=std::env::var_os("ATLAS_RESOURCE_ROOT").map(PathBuf::from).unwrap_or_else(|| if cfg!(debug_assertions) {PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")} else {packaged});
            let backend=Backend::start(app.handle().clone(),&resources,&data)?;app.manage(backend);
            let builder=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("Atlas-CHAT.html".into()))
                .initialization_script(if cfg!(debug_assertions)&&std::env::var_os("ATLAS_VALIDATION_SCRIPT").is_some(){"window.__atlasValidationMode=true;"}else{""})
                .title("AtlasChat").inner_size(1240.0,850.0).min_inner_size(650.0,500.0).decorations(false)
                .background_color(tauri::window::Color(16,16,17,255)).data_directory(data.join("webview"))
                .drag_and_drop(false)
                .on_navigation(|url| matches!(url.path(),"/Atlas-CHAT.html"|"/index.html") && (url.scheme()=="tauri" || url.host_str()==Some("tauri.localhost")))
                .on_new_window(|url,_| {if url.scheme()=="https" {let _=open::that_detached(url.as_str());}tauri::webview::NewWindowResponse::Deny});
            let window=builder.build()?;
            native::deny_browser_permissions(&window)?;
            let handle=app.handle().clone();
            window.on_window_event(move |event| { if matches!(event,tauri::WindowEvent::Destroyed) { handle.exit(0); } });
            #[cfg(debug_assertions)]
            if let Some(script)=std::env::var_os("ATLAS_VALIDATION_SCRIPT") {
                let script=std::fs::read_to_string(script)?;let output=data.clone();let handle=app.handle().clone();let target=window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let started=native::cdp(&target,"Runtime.evaluate",json!({"expression":script,"returnByValue":true})).await;
                    let _=std::fs::write(output.join("validation-start.json"),format!("{started:?}"));
                    for _ in 0..2400 {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        if let Ok(result)=native::cdp(&target,"Runtime.evaluate",json!({"expression":"JSON.stringify(window.__atlasValidation||{pending:true})","returnByValue":true})).await {
                            if let Some(text)=result["result"]["value"].as_str() {
                                let _=std::fs::write(output.join("validation.json"),text);
                                if let Ok(value)=serde_json::from_str::<Value>(text) { if value["done"]==true {
                                    if let Ok(image)=native::cdp(&target,"Page.captureScreenshot",json!({"format":"png"})).await {if let Some(image)=image["data"].as_str(){if let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(image){let _=std::fs::write(output.join("validation.png"),bytes);}}}
                                    handle.exit(0);return;
                                } }
                            }
                        }
                    }
                    handle.exit(2);
                });
            }
            #[cfg(debug_assertions)] if std::env::var_os("ATLAS_DEVTOOLS").is_some() { window.open_devtools(); }
            Ok(())
        }).build(tauri::generate_context!()).expect("AtlasChat could not initialize");
    app.run(|app,event| { if matches!(event,tauri::RunEvent::Exit) { app.state::<Arc<Backend>>().shutdown(); } });
}
