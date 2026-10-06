use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// Each probe owns a fresh process: init installs global metrics/subscribers,
// and tests must not mutate OTEL environment variables in a multithreaded host.
fn probe(endpoint: &str, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "export_probe", "--ignored", "--nocapture"]);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("OTEL_") {
            command.env_remove(key);
        }
    }
    command.env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", endpoint);
    command.env("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "3000");
    command.env("NO_PROXY", "127.0.0.1");
    command.env("ASSETLIBRARY_TELEMETRY_TEST_PROBE", mode);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command
}

fn run_probe(mut command: Command) {
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "isolated OTLP probe failed: {status}");
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("isolated OTLP probe exceeded its deadline");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn request(stream: &mut TcpStream) -> Vec<u8> {
    // Windows may inherit the listener's nonblocking mode on accepted sockets.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0, "request closed before its body completed");
        bytes.extend_from_slice(&buffer[..count]);
        assert!(bytes.len() <= 64 * 1024, "test request must stay bounded");
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            let headers = std::str::from_utf8(&bytes[..end]).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .expect("OTLP protobuf request has a Content-Length");
            if bytes.len() >= end + 4 + length {
                assert!(length > 0);
                return bytes;
            }
        }
    }
}

#[test]
fn otlp_http_exports_protobuf_and_retries_transient_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/traces", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut requests = Vec::new();
        while requests.len() < 2 && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    requests.push(request(&mut stream));
                    let status = if requests.len() == 1 {
                        "503 Service Unavailable"
                    } else {
                        "200 OK"
                    };
                    write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nRetry-After: 0\r\nConnection: close\r\n\r\n").unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("local OTLP listener failed: {error}"),
            }
        }
        requests
    });
    run_probe(probe(&endpoint, "export"));
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2, "transient export must retry");
    for bytes in &requests {
        let end = bytes
            .windows(4)
            .position(|value| value == b"\r\n\r\n")
            .unwrap();
        let headers = std::str::from_utf8(&bytes[..end])
            .unwrap()
            .to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/traces http/1.1\r\n"));
        assert!(headers.contains("content-type: application/x-protobuf"));
        assert!(!headers.contains("authorization:"));
        assert!(
            bytes[end + 4..]
                .windows(b"otel.contract".len())
                .any(|value| value == b"otel.contract")
        );
    }
    assert_eq!(
        requests[0], requests[1],
        "retry must preserve the exported batch"
    );
}

#[test]
fn invalid_configured_endpoint_fails_closed() {
    run_probe(probe("http://[invalid", "invalid"));
}

#[test]
#[ignore = "subprocess helper invoked by the OTLP contract tests"]
fn export_probe() {
    let mode = std::env::var("ASSETLIBRARY_TELEMETRY_TEST_PROBE").unwrap();
    let telemetry = assetlibrary_telemetry::init(
        "assetlibrary-otel-contract",
        assetlibrary_telemetry::MetricsEndpoint::Embedded,
    );
    if mode == "invalid" {
        assert!(telemetry.is_err());
        return;
    }
    let telemetry = telemetry.unwrap();
    tracing::info_span!("otel.contract").in_scope(|| tracing::info!("export contract"));
    // Drop must flush the batch exporter before this process exits.
    drop(telemetry);
}
