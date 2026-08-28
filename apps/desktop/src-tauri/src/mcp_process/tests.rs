#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    include!("tests/framing.rs");
    include!("tests/oauth.rs");
    include!("tests/stdio.rs");
}
