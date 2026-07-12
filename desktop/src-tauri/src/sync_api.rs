use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct SyncApiResponse {
    pub ok: bool,
    pub status: u16,
    pub data: Option<Value>,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn sync_api_request(
    method: String,
    server_url: String,
    path: String,
    api_key: Option<String>,
    body: Option<Value>,
) -> Result<SyncApiResponse, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let url = format!("{}{}", server_url.trim_end_matches('/'), path);

    let client = reqwest::Client::builder()
        .user_agent("TrackSuite.work Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.request(method, &url);
    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.header("X-API-KEY", api_key);
    }
    request = request.header("X-App-Version", env!("CARGO_PKG_VERSION"));
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body_bytes = response.bytes().await.map_err(|e| e.to_string())?;

    let json = if content_type.contains("application/json") && !body_bytes.is_empty() {
        serde_json::from_slice::<Value>(&body_bytes).ok()
    } else {
        None
    };

    let message = if ok {
        None
    } else if let Some(detail) = json
        .as_ref()
        .and_then(|value| value.get("detail"))
        .and_then(|value| value.as_str())
    {
        Some(detail.to_string())
    } else {
        let text = String::from_utf8_lossy(&body_bytes).trim().to_string();
        if text.is_empty() {
            Some(format!("Request failed with status {}", status))
        } else {
            Some(text)
        }
    };

    Ok(SyncApiResponse {
        ok,
        status,
        data: if ok { json } else { None },
        message,
    })
}