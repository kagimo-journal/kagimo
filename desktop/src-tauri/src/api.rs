//! The page's /api requests, sent to the sync server from here (frontend/src/api/client.ts calls
//! the bridge's `api` instead of fetch in the desktop app).
//!
//! The server's session cookies live in this process's cookie jar and never reach the page; they
//! are kept between runs in the computer's credential store (SavedJar). The server expects requests
//! from its own origin (SPEC §5), so that is what they say.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use cookie_store::{CookieStore, RawCookie};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{Error, Result};
use crate::keys::Keys;

/// Request headers that describe the page rather than the request; the server gets its own.
const DROP_REQUEST: [&str; 8] = [
    "host",
    "origin",
    "referer",
    "cookie",
    "connection",
    "content-length",
    "accept-encoding",
    "user-agent",
];
/// Response headers that describe the transfer, or that belong to the server's own pages.
const DROP_RESPONSE: [&str; 11] = [
    "set-cookie",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-security-policy",
    "strict-transport-security",
    "x-frame-options",
    "cross-origin-opener-policy",
    "permissions-policy",
];

#[derive(Deserialize)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// base64
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// base64; None when the response has no body
    pub body: Option<String>,
}

/// What the page is told when the server can't be reached; the bridge turns it into the same
/// TypeError fetch would throw.
pub const NETWORK_ERROR: &str = "network";

/// Where the cookie jar is kept, under the credential store's account for it.
const SESSION: &str = "sync-session";

/// The sync server's cookies, saved whenever the server sets one so that sync stays signed in
/// across restarts. Only cookies that have an expiry are kept (the server's all do).
pub struct SavedJar {
    store: Mutex<CookieStore>,
    keys: Keys,
}

impl SavedJar {
    fn load(keys: Keys) -> Self {
        let store = keys
            .load(SESSION)
            .ok()
            .flatten()
            .and_then(|b| cookie_store::serde::json::load(&b[..]).ok())
            .unwrap_or_default();
        SavedJar {
            store: Mutex::new(store),
            keys,
        }
    }

    fn save(&self, store: &CookieStore) {
        let mut buf = vec![];
        if cookie_store::serde::json::save(store, &mut buf).is_ok()
            && let Err(e) = self.keys.save(SESSION, &buf)
        {
            eprintln!("Couldn't keep the sync session: {e}");
        }
    }

    fn clear(&self) {
        self.store.lock().unwrap().clear();
        let _ = self.keys.delete(SESSION);
    }
}

impl reqwest::cookie::CookieStore for SavedJar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        let cookies: Vec<RawCookie<'static>> = headers
            .filter_map(|v| v.to_str().ok())
            .filter_map(|s| RawCookie::parse(s.to_owned()).ok())
            .collect();
        if cookies.is_empty() {
            return;
        }
        let mut store = self.store.lock().unwrap();
        store.store_response_cookies(cookies.into_iter(), url);
        self.save(&store);
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        let store = self.store.lock().unwrap();
        let s = store
            .get_request_values(url)
            .map(|(n, v)| format!("{n}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        if s.is_empty() { None } else { HeaderValue::from_str(&s).ok() }
    }
}

pub struct SyncClient {
    client: reqwest::Client,
    jar: Arc<SavedJar>,
}

impl SyncClient {
    pub fn new(keys: Keys) -> Self {
        let jar = Arc::new(SavedJar::load(keys));
        Self {
            client: Self::build(jar.clone()),
            jar,
        }
    }

    fn build(jar: Arc<SavedJar>) -> reqwest::Client {
        reqwest::Client::builder()
            .cookie_provider(jar)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("Kagimo-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client")
    }

    /// Forgets the session: another server's cookies mean nothing to the next one.
    pub fn reset(&self) {
        self.jar.clear();
    }

    pub async fn send(&self, server: &str, req: ApiRequest) -> Result<ApiResponse> {
        let url = api_url(server, &req.path)?;
        let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes()).map_err(|_| Error::msg("Invalid method"))?;
        let mut rb = self.client.request(method, url).header("Origin", server);
        for (k, v) in &req.headers {
            let lk = k.to_ascii_lowercase();
            if DROP_REQUEST.contains(&lk.as_str()) || lk.starts_with("sec-") {
                continue;
            }
            rb = rb.header(k, v);
        }
        if let Some(b) = req.body {
            rb = rb.body(B64.decode(b).map_err(|_| Error::msg("Invalid body"))?);
        }
        let res = rb.send().await.map_err(|_| Error::msg(NETWORK_ERROR))?;
        if res.status().is_redirection() {
            // The API never redirects; one that does isn't the server it claims to be.
            return Err(Error::msg(NETWORK_ERROR));
        }
        let status = res.status();
        let headers = res
            .headers()
            .iter()
            .filter(|(k, _)| !DROP_RESPONSE.contains(&k.as_str()))
            .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
            .collect();
        let empty = matches!(status.as_u16(), 204 | 205 | 304);
        let bytes = res.bytes().await.map_err(|_| Error::msg(NETWORK_ERROR))?;
        Ok(ApiResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers,
            body: (!empty).then(|| B64.encode(&bytes)),
        })
    }
}

/// The server URL for a page's /api path. Only /api and below, on that server.
pub fn api_url(server: &str, path: &str) -> Result<Url> {
    let bad = || Error::msg("Not an API path");
    let p = path.split(['?', '#']).next().unwrap_or("");
    if !(p == "/api" || p.starts_with("/api/")) || p.contains("//") || p.contains('\\') || p.split('/').any(|s| s == ".." || s == ".") {
        return Err(bad());
    }
    let url = Url::parse(&format!("{server}{path}")).map_err(|_| bad())?;
    if url.origin().ascii_serialization() != server {
        return Err(bad());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_stays_on_the_server_under_api() {
        let s = "https://kagimo.com";
        assert_eq!(
            api_url(s, "/api/sync?since=5").unwrap().as_str(),
            "https://kagimo.com/api/sync?since=5"
        );
        assert_eq!(api_url(s, "/api").unwrap().as_str(), "https://kagimo.com/api");
        for bad in [
            "/apix",
            "/",
            "/api/../admin",
            "/api/./x",
            "//evil.com/api/x",
            "/api//x",
            "@evil.com/api",
            "/api\\x",
            ".evil.com/api/x",
        ] {
            assert!(api_url(s, bad).is_err(), "{bad}");
        }
    }
}
