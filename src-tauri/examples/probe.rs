//! Diagnostic: exercise the EXACT client config `submit_entry` uses against the
//! real webhook, with a semantic no-op update so nothing in the sheet changes.
use std::time::Duration;

const MAX_HOPS: usize = 10;
const READ_TIMEOUT: u64 = 18;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn serves_stored_output(u: &reqwest::Url) -> bool {
    u.host_str().is_some_and(|h| h == "googleusercontent.com" || h.ends_with(".googleusercontent.com"))
}

async fn read_json(client: &reqwest::Client, url: &str, receipt: bool) -> Result<serde_json::Value, String> {
    let mut next = url.to_string();
    for hop in 0..MAX_HOPS {
        let resp = client
            .get(&next)
            .timeout(Duration::from_secs(READ_TIMEOUT))
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
            let loc = loc.to_str().map_err(|e| format!("bad redirect: {e}"))?;
            let host = reqwest::Url::parse(&next).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
            let tgt = reqwest::Url::parse(&next).and_then(|b| b.join(loc)).ok();
            let (thost, tpath) = tgt
                .as_ref()
                .map(|u| (u.host_str().unwrap_or("?").to_string(), u.path().to_string()))
                .unwrap_or_default();
            println!("      hop {hop}: {} {} -> {}{}", resp.status(), host, thost, tpath);
            if let Some(t) = tgt.as_ref() {
                if t.path().ends_with("/exec") {
                    return Err("REFUSED: redirected back to the script instead of its output".into());
                }
                if receipt && !serves_stored_output(t) {
                    return Err(format!("REFUSED: receipt redirected to {}", t.host_str().unwrap_or("?")));
                }
            }
            next = reqwest::Url::parse(&next)
                .and_then(|b| b.join(loc))
                .map(|u| u.to_string())
                .map_err(|e| format!("bad redirect target: {e}"))?;
            continue;
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        return resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("bad response: {e}"));
    }
    Err("too many redirects".into())
}

#[tokio::main]
async fn main() {
    let cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(&std::env::var("APPDATA").unwrap())
                .join("com.matthewtershi.sheetshortcut")
                .join("config.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let url = cfg["webhook_url"].as_str().unwrap().to_string();
    let token = cfg["token"].as_str().unwrap().to_string();
    let client = http_client();

    // Which row to no-op update, plus its current values.
    let mut probe = reqwest::Url::parse(&url).unwrap();
    probe.query_pairs_mut().append_pair("token", &token).append_pair("limit", "3");
    let mut rows = serde_json::Value::Null;
    for a in 0..8u64 {
        match read_json(&client, probe.as_str(), false).await {
            Ok(v) => { rows = v; break; }
            Err(e) => {
                println!("   initial read attempt {} failed: {e}", a + 1);
                tokio::time::sleep(Duration::from_millis(1200 * (a + 1))).await;
            }
        }
    }
    assert!(!rows.is_null(), "could not read rows at all");
    let r = &rows["rows"][0];
    println!("target row {} company={:?}", r["row"], r["company"].as_str().unwrap());

    let body = serde_json::json!({
        "token": token, "action": "update", "row": r["row"],
        "company": r["company"], "link": r["link"], "status": r["status"],
    });

    for i in 0..10 {
        print!("\nPOST #{i}: ");
        let t0 = std::time::Instant::now();
        match client
            .post(&url)
            .timeout(Duration::from_secs(90))
            .json(&body)
            .send()
            .await
        {
            Err(e) => println!("*** Network error: {e}"),
            Ok(resp) => {
                let status = resp.status();
                println!("HTTP {status} in {:.1}s", t0.elapsed().as_secs_f32());
                if status.is_redirection() {
                    let loc = resp
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    match loc {
                        None => println!("   *** 3xx with NO Location header ***"),
                        Some(loc) => {
                            let t = reqwest::Url::parse(&url).unwrap().join(&loc).unwrap().to_string();
                            let mut got = None;
                            for a in 0..3u64 {
                                match read_json(&client, &t, true).await {
                                    Ok(v) => { got = Some(v); break; }
                                    Err(e) => {
                                        println!("   attempt {}: {e}", a + 1);
                                        if a < 2 { tokio::time::sleep(Duration::from_millis(700 * (a + 1))).await; }
                                    }
                                }
                            }
                            match got {
                                Some(v) => {
                                    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                                    println!("   receipt: {v}   {}", if ok { "OK" } else { "*** WOULD POP THE WINDOW ***" });
                                }
                                None => println!("   -> unverified (no popup, row is written)"),
                            }
                        }
                    }
                } else {
                    let txt = resp.text().await.unwrap_or_default();
                    println!("   NOT a redirect. body[..160]: {:?}", &txt[..txt.len().min(160)]);
                }
            }
        }
    }
}
