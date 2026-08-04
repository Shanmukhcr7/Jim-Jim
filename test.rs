fn main() {
    let text = "{\"type\": \"CONNECTION_REQUEST\"}";
    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&text) {
        println!("Parsed OK");
        if json_val["type"] == "CONNECTION_REQUEST" {
            println!("Match OK");
        } else {
            println!("Match FAIL");
        }
    }
}
