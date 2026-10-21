use super::viewer_validation::validate_stream;
use super::*;
use chrono::Duration;

const MACHINE: &str = "m_abcdefghijklmnopqrstuvwxyz";
const ORIGIN: &str = STREAM_ORIGIN;

#[test]
fn validates_exact_origin_path_and_fragment() {
    let now = Utc::now();
    let url = format!("{ORIGIN}/dashboard/desktop/{MACHINE}#token=opaque");
    let stream = validate_stream(MACHINE, ORIGIN, &url, now + Duration::seconds(60), now).unwrap();
    assert_eq!(stream.open_url(), url);
    assert!(stream.navigation_policy().allows(&url));
    assert!(!stream
        .navigation_policy()
        .allows(&format!("{ORIGIN}/dashboard/desktop/{MACHINE}#token=other")));
    assert!(!stream.navigation_policy().allows(&format!(
        "{ORIGIN}/dashboard/desktop/{MACHINE}#token%3Dopaque"
    )));
    assert!(!stream.navigation_policy().allows(&format!(
        "{ORIGIN}/dashboard/desktop/{MACHINE}/other#token=opaque"
    )));
}

#[test]
fn refuses_changed_origin_path_query_and_expired_links() {
    let now = Utc::now();
    let cases = [
        format!("https://evil.example/dashboard/desktop/{MACHINE}#token=x"),
        format!("{ORIGIN}/dashboard/desktop/m_other#token=x"),
        format!("{ORIGIN}/dashboard/desktop/{MACHINE}?next=evil#token=x"),
        format!("{ORIGIN}/dashboard/desktop/{MACHINE}#token=x%0A"),
        format!("{ORIGIN}/dashboard/desktop/{MACHINE}#token="),
    ];
    for url in cases {
        assert!(validate_stream(MACHINE, ORIGIN, &url, now + Duration::seconds(60), now).is_err());
    }
    let url = format!("{ORIGIN}/dashboard/desktop/{MACHINE}#token=x");
    assert!(validate_stream(MACHINE, ORIGIN, &url, now, now).is_err());
}

#[test]
fn close_fences_before_revoke_and_reports_acknowledgement() {
    let mut fence = ViewerFence::new(7).unwrap();
    let closed = fence.begin_close(7).unwrap();
    assert!(closed.closed);
    assert_eq!(closed.revoke, RevokeState::Pending);
    fence.acknowledge_revoke();
    assert_eq!(fence.snapshot().revoke, RevokeState::Acknowledged);
}

#[test]
fn close_keeps_remote_revoke_uncertain_when_provider_does_not_ack() {
    let mut fence = ViewerFence::new(3).unwrap();
    fence.begin_close(3).unwrap();
    fence.mark_revoke_unconfirmed();
    assert_eq!(fence.snapshot().revoke, RevokeState::Unconfirmed);
}

#[test]
fn uncertain_close_can_be_retried_with_the_fenced_generation() {
    let mut fence = ViewerFence::new(3).unwrap();
    let closed = fence.begin_close(3).unwrap();
    fence.mark_revoke_unconfirmed();
    let retry = fence.begin_close(closed.generation).unwrap();
    assert_eq!(retry.generation, closed.generation);
    assert_eq!(retry.revoke, RevokeState::Pending);
}

#[test]
fn close_generation_cannot_collide_with_a_reopened_viewer() {
    let first_generation = next_viewer_generation().unwrap();
    let mut fence = ViewerFence::new(first_generation).unwrap();
    let closed = fence.begin_close(first_generation).unwrap();
    let reopened_generation = next_viewer_generation().unwrap();
    assert_ne!(closed.generation, reopened_generation);
}
