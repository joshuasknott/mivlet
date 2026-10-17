//! Fixed native operation only. Caller text is a data argument, never source.
pub(super) const FILL_EMPTY: &str = r#"function(text, origin, metadata) {
  'use strict';
  if (!this.isConnected || this.ownerDocument !== document || location.origin !== origin || document.visibilityState !== 'visible') return 'stale';
  if (this.tagName !== metadata.tag || !['INPUT','TEXTAREA'].includes(this.tagName)) return 'unsupported';
  const attributes = Array.from(this.attributes, a => [a.name, a.value]).flat();
  if (attributes.length !== metadata.attributes.length || attributes.some((a,i) => a !== metadata.attributes[i])) return 'stale';
  if (this.disabled || this.readOnly || this.hidden || this.isContentEditable) return 'unsupported';
  if (this.maxLength >= 0 && text.length > this.maxLength) return 'unsupported';
  if (this.tagName === 'INPUT' && !['text','search'].includes(this.type)) return 'unsupported';
  const descriptor = Object.getOwnPropertyDescriptor(this.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value');
  if (!descriptor || descriptor.get.call(this) !== '') return 'not-empty';
  descriptor.set.call(this, text);
  this.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:text}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  return 'filled';
}"#;
