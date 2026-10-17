//! A normal local recovery checkpoint before a separately approved cloud import.
use super::*;
pub(crate) fn capture_before_import(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    request_id: &str,
) -> Result<Checkpoint, String> {
    // The cloud owner is parked for explicit import, so it must not borrow a
    // different executing Work's conversation anchor. Its exact canonical
    // import receipt links this normal file checkpoint to the hosted task.
    storage::capture(
        directory,
        repo,
        ticket,
        "Before hosted file import",
        request_id,
        "before-task",
    )
}
