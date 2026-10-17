//! RFC6455 over the existing pinned native HTTPS client. Only bounded UTF-8
//! messages and control frames; no compression, cookies, redirects or proxy.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
const MAX: usize = 71_680;
pub(super) fn accept(key: &str) -> String {
    let bytes = format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(
        ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, bytes.as_bytes()).as_ref(),
    )
}
pub(super) enum Message {
    Text(String),
    Ping(Vec<u8>),
    Pong,
    Close,
}
pub(super) struct Reader<R> {
    input: R,
    fragments: Vec<u8>,
    fragmented: bool,
    fragment_count: usize,
}
impl<R: AsyncRead + Unpin> Reader<R> {
    pub fn new(input: R) -> Self {
        Self {
            input,
            fragments: Vec::new(),
            fragmented: false,
            fragment_count: 0,
        }
    }
    pub async fn read(&mut self) -> Result<Message, String> {
        loop {
            let mut head = [0; 2];
            self.input
                .read_exact(&mut head)
                .await
                .map_err(|_| "Phone relay connection ended.")?;
            let fin = head[0] & 0x80 != 0;
            let op = head[0] & 15;
            if head[0] & 0x70 != 0 || head[1] & 0x80 != 0 {
                return Err("Invalid phone relay frame.".into());
            }
            let marker = head[1] & 127;
            let length = match marker {
                126 => {
                    let n = self
                        .input
                        .read_u16()
                        .await
                        .map_err(|_| "Interrupted relay frame.")?
                        as usize;
                    if n < 126 {
                        return Err("Invalid relay length.".into());
                    }
                    n
                }
                127 => {
                    let n = self
                        .input
                        .read_u64()
                        .await
                        .map_err(|_| "Interrupted relay frame.")?;
                    if n < 65_536 || n > MAX as u64 {
                        return Err("Invalid relay length.".into());
                    }
                    n as usize
                }
                n => n as usize,
            };
            if length > MAX || (op >= 8 && (!fin || length > 125)) {
                return Err("Phone relay frame exceeded its limit.".into());
            }
            let mut bytes = vec![0; length];
            self.input
                .read_exact(&mut bytes)
                .await
                .map_err(|_| "Interrupted relay frame.")?;
            match op {
                8 => return Ok(Message::Close),
                9 => return Ok(Message::Ping(bytes)),
                10 => return Ok(Message::Pong),
                1 if !self.fragmented => {
                    if fin {
                        return String::from_utf8(bytes)
                            .map(Message::Text)
                            .map_err(|_| "Invalid relay text.".into());
                    }
                    self.fragmented = true;
                    self.fragments = bytes;
                    self.fragment_count = 1;
                }
                0 if self.fragmented => {
                    self.fragment_count += 1;
                    if self.fragment_count > 128 {
                        return Err("Phone relay fragmented message exceeded its limit.".into());
                    }
                    if self.fragments.len() + bytes.len() > MAX {
                        return Err("Phone relay message exceeded its limit.".into());
                    }
                    self.fragments.extend_from_slice(&bytes);
                    if fin {
                        self.fragmented = false;
                        return String::from_utf8(std::mem::take(&mut self.fragments))
                            .map(Message::Text)
                            .map_err(|_| "Invalid relay text.".into());
                    }
                }
                _ => return Err("Unsupported phone relay frame.".into()),
            }
        }
    }
}
pub(super) async fn write<W: AsyncWrite + Unpin>(
    output: &mut W,
    op: u8,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() > MAX || ![1, 8, 9, 10].contains(&op) || op >= 8 && bytes.len() > 125 {
        return Err("Invalid outgoing phone relay frame.".into());
    }
    let mut mask = [0; 4];
    getrandom::fill(&mut mask).map_err(|_| "Secure randomness unavailable.")?;
    let mut frame = vec![0x80 | op];
    if bytes.len() < 126 {
        frame.push(0x80 | bytes.len() as u8);
    } else if bytes.len() <= 65_535 {
        frame.push(0xfe);
        frame.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    } else {
        frame.push(0xff);
        frame.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        output.write_all(&frame).await?;
        output.flush().await
    })
    .await
    .map_err(|_| "Phone relay delivery is uncertain.")?
    .map_err(|_| "Phone relay delivery is uncertain.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_handshake_accept_is_pinned() {
        assert_eq!(
            accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }
    #[tokio::test]
    async fn fragmented_text_allows_control_but_rejects_masked_server_and_binary() {
        let bytes = [0x01, 2, b'{', b'"', 0x89, 1, b'x', 0x80, 2, b'"', b'}'];
        let mut reader = Reader::new(&bytes[..]);
        assert!(matches!(reader.read().await.unwrap(), Message::Ping(_)));
        assert!(matches!(reader.read().await.unwrap(), Message::Text(value) if value == "{\"\"}"));
        assert!(Reader::new(&[0x81, 0x80][..]).read().await.is_err());
        assert!(Reader::new(&[0x82, 0][..]).read().await.is_err());
    }
    #[tokio::test]
    async fn oversized_length_rejected_before_payload_allocation() {
        let mut input = vec![0x81, 127];
        input.extend_from_slice(&100_000_u64.to_be_bytes());
        assert!(Reader::new(input.as_slice()).read().await.is_err());
    }
}
