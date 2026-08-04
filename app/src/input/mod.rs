use tracing::info;

pub struct InputEngine {}

impl InputEngine {
    pub fn new() -> Self {
        info!("Initializing Windows SendInput API hook");
        Self {}
    }
}
