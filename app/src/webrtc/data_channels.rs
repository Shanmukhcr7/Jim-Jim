use tracing::info;

pub struct DataChannels {
    pub mouse: Option<String>,
    pub keyboard: Option<String>,
    pub clipboard: Option<String>,
    pub control: Option<String>,
}

impl DataChannels {
    pub fn new() -> Self {
        info!("Initializing distinct DataChannels: Mouse, Keyboard, Clipboard, Control");
        Self {
            mouse: None,
            keyboard: None,
            clipboard: None,
            control: None,
        }
    }
}
