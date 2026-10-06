//! Regression for cancellation while SQLx 0.8 is awaiting BEGIN ReadyForQuery.
//! The proxy only delays one protocol response on a disposable loopback server.
use super::*;
use sqlx::postgres::PgSslMode;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

async fn forward(
    client: TcpStream,
    backend: std::net::SocketAddr,
    delayed: Arc<AtomicBool>,
) -> Result<(), std::io::Error> {
    let server = TcpStream::connect(backend).await?;
    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.into_split();
    let upstream = tokio::io::copy(&mut client_read, &mut server_write);
    let downstream = async {
        let mut pending_delay = false;
        loop {
            let mut header = [0_u8; 5];
            server_read.read_exact(&mut header).await?;
            let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
            if !(4..=1024 * 1024).contains(&length) {
                return Err(std::io::Error::other(
                    "unexpected oversized fixture protocol frame",
                ));
            }
            let mut body = vec![0; length - 4];
            server_read.read_exact(&mut body).await?;
            if header[0] == b'C' && body == b"BEGIN\0" && !delayed.swap(true, Ordering::SeqCst) {
                pending_delay = true;
            }
            if header[0] == b'Z' && pending_delay {
                pending_delay = false;
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            client_write.write_all(&header).await?;
            client_write.write_all(&body).await?;
        }
    };
    tokio::select! {
        result = upstream => result.map(|_| ()),
        result = downstream => result,
    }
}

pub(super) async fn during_begin() {
    // The enclosing gate has already validated the explicit disposable URL.
    let url = std::env::var("ASSETLIBRARY_SEARCH_TEST_DATABASE_URL").unwrap();
    let options = PgConnectOptions::from_str(&url).unwrap();
    let backend = tokio::net::lookup_host((options.get_host(), options.get_port()))
        .await
        .unwrap()
        .find(|address| address.ip().is_loopback())
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    let delayed = Arc::new(AtomicBool::new(false));
    let proxy_delayed = delayed.clone();
    let proxy = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted.unwrap();
                    connections.spawn(forward(stream, backend, proxy_delayed.clone()));
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(
            options
                .host("127.0.0.1")
                .port(proxy_port)
                .ssl_mode(PgSslMode::Disable),
        )
        .await
        .unwrap();
    let before: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let repository = PostgresSearchRepository::new(pool.clone());
    assert!(matches!(
        repository.search(&filter()).await,
        Err(SearchError::Unavailable)
    ));
    assert!(
        delayed.load(Ordering::SeqCst),
        "regression must interrupt a real BEGIN response"
    );
    // Wait until the delayed response would have reached an unguarded borrower.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let after: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(
        before, after,
        "interrupted BEGIN connection must never return to the shared pool"
    );
    let autocommit: bool = sqlx::query_scalar(
        "SELECT clock_timestamp() - transaction_timestamp() < INTERVAL '1 second'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        autocommit,
        "next borrower must not inherit an old transaction"
    );
    pool.close().await;
    proxy.abort();
    let _ = proxy.await;
}
