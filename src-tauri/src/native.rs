use crate::backend::Backend;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub async fn dispatch(app: &AppHandle, backend: &Arc<Backend>, message: &Value) -> Result<Value, String> {
    let value = &message["value"];
    match message["name"].as_str().unwrap_or("") {
        "dialogMessage" => {
            let options = value.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let buttons = options["buttons"].as_array().ok_or("Missing dialog buttons")?;
                let labels: Vec<String> = buttons.iter().map(|s| s.as_str().unwrap_or("Cancel").to_string()).collect();
                let custom = match labels.len() { 2 => rfd::MessageButtons::OkCancelCustom(labels[0].clone(), labels[1].clone()),
                    3 => rfd::MessageButtons::YesNoCancelCustom(labels[0].clone(), labels[1].clone(), labels[2].clone()), _ => return Err("Unsupported dialog".into()) };
                let result = rfd::MessageDialog::new().set_title(options["title"].as_str().unwrap_or("AtlasChat"))
                    .set_description(format!("{}\n\n{}", options["message"].as_str().unwrap_or(""), options["detail"].as_str().unwrap_or("")))
                    .set_buttons(custom).show();
                let response = match result { rfd::MessageDialogResult::Custom(label) => labels.iter().position(|s| s == &label).unwrap_or(labels.len()-1),
                    rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => 0, rfd::MessageDialogResult::No => 1, _ => labels.len()-1 };
                Ok(json!({"response":response}))
            }).await.map_err(|e|e.to_string())?
        }
        "dialogOpen" | "dialogSave" => {
            let save = message["name"] == "dialogSave"; let options = value.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut dialog = rfd::FileDialog::new();
                if let Some(name) = options["defaultPath"].as_str() { dialog = dialog.set_file_name(name); }
                if let Some(filters) = options["filters"].as_array() { for filter in filters {
                    let extensions: Vec<&str> = filter["extensions"].as_array().map(|a|a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    dialog = dialog.add_filter(filter["name"].as_str().unwrap_or("File"), &extensions);
                } }
                let selected = if save { dialog.save_file() } else { dialog.pick_file() };
                Ok(match selected { Some(path) => json!({"canceled":false,"filePath":path,"filePaths":[path]}), None => json!({"canceled":true,"filePaths":[]}) })
            }).await.map_err(|e|e.to_string())?
        }
        "openExternal" => { let url = value.as_str().ok_or("Invalid link")?; if !url.starts_with("https://") { return Err("Only HTTPS links can open externally".into()); } open::that_detached(url).map_err(|e|e.to_string())?; Ok(json!(true)) }
        "previewOpen" => {
            let label = value["label"].as_str().ok_or("Missing preview label")?.to_string();
            if !label.starts_with("preview-") { return Err("Invalid preview label".into()); }
            let source = url::Url::parse(value["url"].as_str().ok_or("Missing preview URL")?).map_err(|e|e.to_string())?;
            if source.scheme() != "atlas-preview" { return Err("Invalid preview scheme".into()); }
            let url = source;
            let handle = app.clone(); let connection = backend.clone(); let event_label = label.clone();
            let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url::Url::parse("about:blank").unwrap()))
                .title(value["title"].as_str().unwrap_or("Atlas Project")).inner_size(1050.0,750.0)
                .visible(value["visible"].as_bool().unwrap_or(false)).devtools(false).incognito(true)
                .on_navigation(|url| url.as_str()=="about:blank" || url.scheme() == "atlas-preview" || url.host_str().is_some_and(|host|host.starts_with("atlas-preview.")))
                .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny);
            let window = builder.build().map_err(|e|e.to_string())?;
            deny_browser_permissions(&window)?;
            subscribe_preview(&window,backend.clone())?;
            cdp(&window,"Runtime.enable",json!({})).await?;
            cdp(&window,"Network.enable",json!({})).await?;
            // WebView2's dynamic Navigate does not apply Wry's initial-URL
            // custom-protocol workaround, so use its intercepted HTTP origin.
            #[cfg(windows)]
            let url=url::Url::parse(&format!("http://atlas-preview.{}{}",url.host_str().ok_or("Invalid preview host")?,url.path())).map_err(|e|e.to_string())?;
            window.navigate(url).map_err(|e|e.to_string())?;
            window.on_window_event(move |event| if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = connection.send(&json!({"type":"previewEvent","label":event_label,"method":"closed"}));
            });
            let _ = handle;
            let mut status=Value::Null;
            for _ in 0..100 {
                status=cdp(&window,"Runtime.evaluate",json!({"expression":"({href:location.href,ready:document.readyState})","returnByValue":true})).await?;
                if status["result"]["value"]["ready"]=="complete" && status["result"]["value"]["href"].as_str().is_some_and(|href|href.contains("atlas-preview")) { return Ok(json!(true)); }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            return Err(format!("Project preview did not load: {status}"));
        }
        "previewClose" => { if let Some(label) = value["label"].as_str() { if label.starts_with("preview-") { if let Some(win) = app.get_webview_window(label) { win.close().map_err(|e|e.to_string())?; } } } Ok(json!(true)) }
        "previewCdp" | "previewEval" | "previewCapture" => {
            let label = value["label"].as_str().ok_or("Missing window")?;
            if !label.starts_with("preview-") { return Err("Cannot evaluate the privileged application".into()); }
            let mut window = app.get_webview_window(label);
            for _ in 0..100 { if window.is_some() { break; } tokio::time::sleep(std::time::Duration::from_millis(25)).await; window = app.get_webview_window(label); }
            let window = window.ok_or("Preview closed")?;
            if message["name"] == "previewCdp" {
                let method = value["method"].as_str().ok_or("Missing method")?;
                if method != "Runtime.enable" { return Err("Unsupported preview debugging operation".into()); }
                cdp(&window,method,value["params"].clone()).await
            } else if message["name"] == "previewCapture" { let result = cdp(&window,"Page.captureScreenshot",json!({"format":"png"})).await?; Ok(result["data"].clone()) }
            else { evaluate(&window,value["code"].as_str().ok_or("Missing preview assertion")?).await }
        }
        _ => Err("Unknown native operation".into())
    }
}

#[cfg(windows)]
pub fn deny_browser_permissions(window: &tauri::WebviewWindow) -> Result<(),String> {
    window.with_webview(move |view| unsafe {
        if let Ok(core)=view.controller().CoreWebView2() {
            let callback=webview2_com::PermissionRequestedEventHandler::create(Box::new(|_,args| {
                if let Some(args)=args { args.SetState(webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY)?; }Ok(())
            }));
            let mut token=0;let _=core.add_PermissionRequested(&callback,&mut token);
        }
    }).map_err(|e|e.to_string())
}
#[cfg(not(windows))]
pub fn deny_browser_permissions(_window: &tauri::WebviewWindow) -> Result<(),String> {Ok(())}

#[cfg(windows)]
fn subscribe_preview(window: &tauri::WebviewWindow, backend: Arc<Backend>) -> Result<(),String> {
    use windows::core::{HSTRING,PCWSTR,PWSTR};
    let label=window.label().to_string();
    window.with_webview(move |view| unsafe {
        if let Ok(core)=view.controller().CoreWebView2() {
            for method in ["Runtime.exceptionThrown","Runtime.consoleAPICalled","Network.loadingFailed"] {
                let name=HSTRING::from(method);
                if let Ok(receiver)=core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr())) {
                    let backend=backend.clone();let label=label.clone();
                    let callback=webview2_com::DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_,args| {
                        if let Some(args)=args {
                            let mut raw=PWSTR::null();args.ParameterObjectAsJson(&mut raw)?;
                            let text=webview2_com::CoTaskMemPWSTR::from(raw).to_string();
                            if let Ok(params)=serde_json::from_str::<Value>(&text) {let _=backend.send(&json!({"type":"previewEvent","label":label,"method":method,"params":params}));}
                        }Ok(())
                    }));
                    let mut token=0;let _=receiver.add_DevToolsProtocolEventReceived(&callback,&mut token);
                }
            }
        }
    }).map_err(|e|e.to_string())
}
#[cfg(not(windows))]
fn subscribe_preview(_window: &tauri::WebviewWindow, _backend: Arc<Backend>) -> Result<(),String> {Ok(())}

#[cfg(windows)]
pub async fn cdp(window: &tauri::WebviewWindow, method: &str, params: Value) -> Result<Value,String> {
    use windows::core::{HSTRING, PCWSTR};
    let method = method.to_string(); let params = params.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.with_webview(move |view| unsafe {
        let callback = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
            let result = status.map_err(|e|e.to_string()).and_then(|_|serde_json::from_str::<Value>(&result).map_err(|e|e.to_string()));
            let _ = sender.send(result); Ok(())
        }));
        let method = HSTRING::from(method); let params = HSTRING::from(params);
        if let Ok(core) = view.controller().CoreWebView2() { let _ = core.CallDevToolsProtocolMethod(PCWSTR(method.as_ptr()),PCWSTR(params.as_ptr()),&callback); }
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10),receiver).await.map_err(|_|"WebView2 operation timed out".to_string())?.map_err(|_|"WebView2 operation closed".to_string())?
}
#[cfg(not(windows))]
pub async fn cdp(_window: &tauri::WebviewWindow, _method: &str, _params: Value) -> Result<Value,String> { Err("Project browser assertions currently require Windows WebView2".into()) }

pub async fn evaluate(window: &tauri::WebviewWindow, code: &str) -> Result<Value,String> {
    let tree = cdp(window,"Page.getFrameTree",json!({})).await?;
    let world = cdp(window,"Page.createIsolatedWorld",json!({"frameId":tree["frameTree"]["frame"]["id"],"worldName":"AtlasProjectChecks"})).await?;
    let result = cdp(window,"Runtime.evaluate",json!({"expression":code,"contextId":world["executionContextId"],"returnByValue":true,"awaitPromise":true})).await?;
    if result.get("exceptionDetails").is_some() { return Err(result["exceptionDetails"].to_string()); }
    Ok(result["result"]["value"].clone())
}
