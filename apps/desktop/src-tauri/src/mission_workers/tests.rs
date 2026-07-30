#[cfg(test)]
mod tests {
    use super::*;

    include!("tests/policy.rs");
    include!("tests/lifecycle.rs");
    include!("tests/settlement.rs");
    include!("tests/approvals.rs");
}
