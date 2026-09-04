pub fn print(value: &serde_json::Value, compact: bool) {
    let rendered = if compact {
        serde_json::to_string(value)
    } else {
        serde_json::to_string_pretty(value)
    }
    .expect("command output must be serializable");
    println!("{rendered}");
}
