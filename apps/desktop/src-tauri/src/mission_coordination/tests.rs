#[cfg(test)]
mod tests {
    use super::*;

    include!("tests/planning.rs");
    include!("tests/terminal.rs");
    include!("tests/persistence.rs");
    include!("tests/joins.rs");
}
