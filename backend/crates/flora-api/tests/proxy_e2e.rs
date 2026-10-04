//! E2E-тесты gateway-fallback против живого апстрима (критерии Фазы 0, §5.1):
//! статусы/заголовки как есть, X-Forwarded-For, стриминг SSE без буферизации,
//! потоковая передача тела запроса, 502 при недоступном апстриме.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use flora_api::versions::FloraVersionResponse;
use flora_shared::config::FloraConfig;
use http_body_util::BodyExt;

/// Апстрим-заглушка «.NET»: эхо заголовков, кастомные статусы, медленный SSE-стрим.
async fn spawn_upstream() -> SocketAddr {
    let app = Router::new()
        .route(
            "/api/echo-headers",
            any(|request: Request| async move {
                let xff = request
                    .headers()
                    .get("x-forwarded-for")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let host = request
                    .headers()
                    .get("host")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                axum::Json(serde_json::json!({ "xff": xff, "host": host }))
            }),
        )
        .route(
            "/api/teapot",
            get(|| async {
                (
                    http::StatusCode::IM_A_TEAPOT,
                    [("x-upstream-header", "kept")],
                    "teapot",
                )
            }),
        )
        .route(
            "/api/upload",
            post(|request: Request| async move {
                let bytes = request
                    .into_body()
                    .collect()
                    .await
                    .map(|c| c.to_bytes())
                    .unwrap_or_default();
                format!("received:{}", bytes.len())
            }),
        )
        .route(
            "/api/sse",
            get(|| async {
                // Два кадра с паузой: первый обязан дойти до клиента до завершения тела.
                let stream = futures_stream();
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        )
        .route(
            "/api/error",
            get(|| async { http::StatusCode::CONFLICT.into_response() }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn futures_stream() -> tokio_stream::wrappers::ReceiverStream<Result<bytes::Bytes, std::io::Error>>
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        tx.send(Ok(bytes::Bytes::from(
            "event: message\ndata: {\"n\":1}\n\n",
        )))
        .await
        .ok();
        // Пауза заметно больше CI-шума: буферизующий прокси отдал бы оба кадра только после неё.
        tokio::time::sleep(Duration::from_millis(800)).await;
        tx.send(Ok(bytes::Bytes::from(
            "event: message\ndata: {\"n\":2}\n\n",
        )))
        .await
        .ok();
    });
    tokio_stream::wrappers::ReceiverStream::new(rx)
}

/// Запускает flora-api шлюз с fallback на upstream, слушает на эфемерном порту.
async fn spawn_gateway(upstream: SocketAddr) -> SocketAddr {
    let cfg = FloraConfig::from_layers(
        "Production",
        &[serde_json::json!({
            "Gateway": { "DotnetUpstream": format!("http://{upstream}") }
        })],
        &[],
    );
    let router = flora_api::build_router(&cfg, FloraVersionResponse::build(None, None)).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_passes_status_headers_and_appends_xff() {
    let upstream = spawn_upstream().await;
    let gateway = spawn_gateway(upstream).await;
    let client = reqwest::Client::new();

    // Статус и кастомный заголовок апстрима — как есть.
    let teapot = client
        .get(format!("http://{gateway}/api/teapot"))
        .send()
        .await
        .unwrap();
    assert_eq!(teapot.status().as_u16(), 418);
    assert_eq!(teapot.headers().get("x-upstream-header").unwrap(), "kept");

    // XFF: существующая цепочка сохраняется, наш hop дописывается в конец.
    let echoed: serde_json::Value = client
        .get(format!("http://{gateway}/api/echo-headers"))
        .header("X-Forwarded-For", "203.0.113.7")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(echoed["xff"], "203.0.113.7, 127.0.0.1");

    // Нативные маршруты не проксируются.
    let health: serde_json::Value = client
        .get(format!("http://{gateway}/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["status"], "healthy");

    // Статусы ошибок апстрима проходят без искажений.
    let conflict = client
        .get(format!("http://{gateway}/api/error"))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status().as_u16(), 409);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_streams_sse_without_buffering() {
    let upstream = spawn_upstream().await;
    let gateway = spawn_gateway(upstream).await;

    let mut response = reqwest::Client::new()
        .get(format!("http://{gateway}/api/sse"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/event-stream",
    );

    // Считаем после заголовков: cold-start/DNS/планировщик CI не должны выглядеть как буферизация.
    let after_headers = std::time::Instant::now();
    let first = response.chunk().await.unwrap().expect("первый SSE-кадр");
    let first_at = after_headers.elapsed();
    assert!(
        std::str::from_utf8(&first).unwrap().contains("\"n\":1"),
        "первый кадр: {first:?}",
    );
    // Апстрим ждёт 800 мс между кадрами; при буферизации первый chunk пришёл бы ≥ ~800 мс.
    assert!(
        first_at < Duration::from_millis(400),
        "первый кадр пришёл слишком поздно ({first_at:?}) — похоже на буферизацию",
    );

    let rest = response.bytes().await.unwrap();
    assert!(std::str::from_utf8(&rest).unwrap().contains("\"n\":2"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_streams_request_bodies_to_upstream() {
    let upstream = spawn_upstream().await;
    let gateway = spawn_gateway(upstream).await;

    // 8 МиБ — заведомо больше дефолтного лимита axum-экстракторов (2 МиБ):
    // проверяет, что прокси не читает тело через экстрактор и не режет загрузки.
    let payload = vec![0u8; 8 * 1024 * 1024];
    let response = reqwest::Client::new()
        .post(format!("http://{gateway}/api/upload"))
        .body(payload)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.text().await.unwrap(),
        format!("received:{}", 8 * 1024 * 1024)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dead_upstream_returns_502() {
    // Порт из эфемерного диапазона, на котором никто не слушает.
    let dead: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let gateway = spawn_gateway(dead).await;
    let response = reqwest::Client::new()
        .get(format!("http://{gateway}/api/anything"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 502);
}
