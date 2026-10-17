//! Read-only empty-file admission. No value or filename is ever read.
pub(super) const EMPTY_FILE: &str = r#"function(origin, expected) {
  'use strict';
  const node = this;
  if (!(node instanceof HTMLInputElement) || !node.isConnected || node.ownerDocument !== document || location.origin !== origin || document.visibilityState !== 'visible') return 'stale';
  const attrs = Array.from(node.attributes, attr => [attr.name, attr.value]).flat();
  if (JSON.stringify(attrs) !== JSON.stringify(expected.attributes) || node.type !== 'file' || node.disabled || node.readOnly || node.multiple || node.webkitdirectory || node.closest('[hidden],[inert],[contenteditable]')) return 'unsupported';
  const style = getComputedStyle(node), rect = node.getBoundingClientRect();
  if (style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return 'unsupported';
  const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').get.call(node);
  return files && files.length === 0 ? 'empty' : 'occupied';
}"#;
