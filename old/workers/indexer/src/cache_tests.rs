use super::Cache;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Reply {
    AckAfter(Duration),
    DropAfterApply,
    DeleteError,
}

struct Server {
    url: String,
    increments: Arc<AtomicUsize>,
    deletes: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        // JoinSet's drop also aborts accepted connections, including sleeping
        // ACK tasks. Failed assertions must not leave a listening fixture.
        self.task.abort();
    }
}

impl Server {
    async fn start(replies: &[Reply]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let increments = Arc::new(AtomicUsize::new(0));
        let deletes = Arc::new(AtomicUsize::new(0));
        let observed = increments.clone();
        let deleted = deletes.clone();
        let replies = replies.to_vec();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            for reply in replies {
                let (socket, _) = tokio::time::timeout(Duration::from_secs(8), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
                let observed = observed.clone();
                let deleted = deleted.clone();
                connections.spawn(async move {
                    tokio::time::timeout(
                        Duration::from_secs(8),
                        serve(socket, reply, observed, deleted),
                    )
                    .await
                    .unwrap();
                });
            }
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        Self {
            url,
            increments,
            deletes,
            task,
        }
    }

    fn counts(&self) -> (usize, usize) {
        (
            self.deletes.load(Ordering::SeqCst),
            self.increments.load(Ordering::SeqCst),
        )
    }

    async fn finish(&mut self) {
        tokio::time::timeout(Duration::from_secs(8), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }
}

async fn command(reader: &mut BufReader<TcpStream>) -> Option<Vec<Vec<u8>>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let count: usize = line.strip_prefix('*')?.trim().parse().ok()?;
    assert!(count <= 16);
    let mut args = Vec::new();
    for _ in 0..count {
        line.clear();
        reader.read_line(&mut line).await.ok()?;
        let length: usize = line.strip_prefix('$')?.trim().parse().ok()?;
        assert!(length <= 1024);
        let mut data = vec![0; length + 2];
        reader.read_exact(&mut data).await.ok()?;
        assert_eq!(&data[length..], b"\r\n");
        data.truncate(length);
        args.push(data);
    }
    Some(args)
}

async fn serve(
    socket: TcpStream,
    reply: Reply,
    increments: Arc<AtomicUsize>,
    deletes: Arc<AtomicUsize>,
) {
    let mut reader = BufReader::new(socket);
    while let Some(args) = command(&mut reader).await {
        match args[0].as_slice() {
            b"CLIENT" => {
                reader.get_mut().write_all(b"+OK\r\n").await.unwrap();
            }
            b"DEL" => {
                assert!(args[1].starts_with(b"assetlibrary:catalog:package:"));
                deletes.fetch_add(1, Ordering::SeqCst);
                let response = if matches!(reply, Reply::DeleteError) {
                    b"-ERR fixture\r\n".as_slice()
                } else {
                    b":1\r\n"
                };
                reader.get_mut().write_all(response).await.unwrap();
            }
            b"INCRBY" => {
                assert_eq!(args[1], b"assetlibrary:catalog:generation");
                assert_eq!(args[2], b"1");
                let value = increments.fetch_add(1, Ordering::SeqCst) + 1;
                match reply {
                    Reply::DropAfterApply => return,
                    Reply::AckAfter(delay) => tokio::time::sleep(delay).await,
                    Reply::DeleteError => panic!("INCR must not follow a failed DEL"),
                }
                let _ = reader
                    .get_mut()
                    .write_all(format!(":{value}\r\n").as_bytes())
                    .await;
            }
            _ => panic!("unexpected fixture command"),
        }
    }
}

async fn bounded(
    result: impl std::future::Future<Output = Result<(), redis::RedisError>>,
) -> Result<(), redis::RedisError> {
    tokio::time::timeout(Duration::from_secs(7), result)
        .await
        .unwrap()
}

#[tokio::test]
async fn ack_after_the_new_default_still_succeeds_inside_our_explicit_budget() {
    let mut server = Server::start(&[Reply::AckAfter(Duration::from_millis(750)); 2]).await;
    let cache = Cache::new(&server.url).unwrap();
    bounded(cache.invalidate(Uuid::nil())).await.unwrap();
    bounded(cache.invalidate_all()).await.unwrap();
    assert_eq!(server.counts(), (1, 2));
    server.finish().await;
}

#[tokio::test]
async fn applied_but_timed_out_invalidation_can_be_retried_with_only_extra_cache_loss() {
    let mut server = Server::start(&[
        Reply::AckAfter(Duration::from_millis(2500)),
        Reply::AckAfter(Duration::ZERO),
    ])
    .await;
    let cache = Cache::new(&server.url).unwrap();
    let error = bounded(cache.invalidate(Uuid::nil())).await.unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(server.counts(), (1, 1));
    // Simulate the unchanged consumer retry after it has not marked processed.
    bounded(cache.invalidate(Uuid::nil())).await.unwrap();
    assert_eq!(server.counts(), (2, 2));
    server.finish().await;
}

#[tokio::test]
async fn disconnect_after_apply_recovers_on_a_fresh_connection() {
    let mut server = Server::start(&[Reply::DropAfterApply, Reply::AckAfter(Duration::ZERO)]).await;
    let cache = Cache::new(&server.url).unwrap();
    assert!(bounded(cache.invalidate_all()).await.is_err());
    assert_eq!(server.counts(), (0, 1));
    bounded(cache.invalidate_all()).await.unwrap();
    assert_eq!(server.counts(), (0, 2));
    server.finish().await;
}

#[tokio::test]
async fn delete_failure_is_not_acknowledged_and_does_not_skip_to_generation() {
    let mut server = Server::start(&[Reply::DeleteError, Reply::AckAfter(Duration::ZERO)]).await;
    let cache = Cache::new(&server.url).unwrap();
    assert!(bounded(cache.invalidate(Uuid::nil())).await.is_err());
    assert_eq!(server.counts(), (1, 0));
    bounded(cache.invalidate(Uuid::nil())).await.unwrap();
    assert_eq!(server.counts(), (2, 1));
    server.finish().await;
}
