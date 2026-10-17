//! Read-only empty-file admission. No value or filename is ever read.
pub(super) const EMPTY_FILE: &str = r#"function(origin, expected) {
  'use strict';
  const node = this;
  if (!(node instanceof HTMLInputElement) || !node.isConnected || node.ownerDocument !== document || location.origin !== origin || document.visibilityState !== 'visible') return 'stale';
  const attrs = Array.from(node.attributes, attr => [attr.name, attr.value]).flat();
  if (JSON.stringify(attrs) !== JSON.stringify(expected.attributes) || node.type !== 'file' || node.disabled || node.readOnly || node.multiple || node.webkitdirectory) return 'unsupported';
  // Element.closest is not marked Affects=Nothing in Blink, so V8 correctly
  // rejects it under throwOnSideEffect. Traverse native properties instead;
  // preserve the hidden/inert/editable fence, including shadow hosts.
  let ancestor = node, depth = 0;
  for (; ancestor && depth < 64; depth++) {
    if (ancestor.hasAttribute('hidden') || ancestor.hasAttribute('inert') || ancestor.hasAttribute('contenteditable')) return 'unsupported';
    ancestor = ancestor.parentElement || (ancestor.parentNode instanceof ShadowRoot ? ancestor.parentNode.host : null);
  }
  if (ancestor) return 'unsupported';
  const style = getComputedStyle(node), rect = node.getBoundingClientRect();
  if (style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return 'unsupported';
  const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').get.call(node);
  return files && files.length === 0 ? 'empty' : 'occupied';
}"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_probe_keeps_side_effect_checked_native_ancestor_and_value_fences() {
        assert!(!EMPTY_FILE.contains(".closest("));
        assert!(EMPTY_FILE.contains("depth < 64"));
        assert!(EMPTY_FILE.contains("instanceof ShadowRoot"));
        assert!(EMPTY_FILE.contains("ancestor.hasAttribute('inert')"));
        assert!(EMPTY_FILE.contains("getComputedStyle(node)"));
        assert!(EMPTY_FILE.contains("'files').get.call(node)"));
        assert!(!EMPTY_FILE.contains("files["));
    }
}
