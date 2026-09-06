import RFB from './upstream/core/rfb.js';
import CodecDetector, { preferredCodecs } from './upstream/core/codecs.js';
import * as Log from './upstream/core/util/logging.js';

export { RFB };

// The pinned client installs mouse listeners even in view-only mode and reads
// optional Kasm UI state before its input guard. Fable owns all input, so detach
// that machinery immediately after each connection attaches its decoder canvas.
class ViewerRFB extends RFB {
  _connect() {
    super._connect();
    const handlers = this._eventHandlers;
    for (const event of ['mousedown', 'mouseup', 'mousemove', 'click', 'contextmenu']) {
      this._canvas.removeEventListener(event, handlers.handleMouse);
    }
    for (const event of ['gesturestart', 'gesturemove', 'gestureend']) {
      this._canvas.removeEventListener(event, handlers.handleGesture);
    }
    this._canvas.removeEventListener('wheel', handlers.handleWheel);
    this._canvas.removeEventListener('mousedown', handlers.focusCanvas);
    this._canvas.removeEventListener('touchstart', handlers.focusCanvas);
    this._canvas.removeEventListener('touchend', handlers.updateHiddenKeyboard);
    this._canvas.removeEventListener('focus', handlers.handleFocusChange);
    window.removeEventListener('focus', handlers.handleFocusChange);
    window.removeEventListener('blur', handlers.handleFocusChange);
    window.removeEventListener('mouseover', handlers.handleMouseOut);
    for (const prefix of ['', 'moz']) {
      document.removeEventListener(`${prefix}pointerlockchange`, handlers.handlePointerLockChange);
      document.removeEventListener(`${prefix}pointerlockerror`, handlers.handlePointerLockError);
    }
    this._keyboard.ungrab();
    this._gestures.detach();
  }
}

export async function createRfb(target, url) {
  Log.initLogging('error');
  let supported = [];
  try { supported = (await new CodecDetector().detect()).getSupportedCodecIds(); }
  catch { /* Rectangle streaming remains available without WebCodecs. */ }
  const touchInput = document.createElement('textarea');
  touchInput.hidden = true;
  touchInput.setAttribute('aria-hidden', 'true');
  target.append(touchInput);
  const rfb = new ViewerRFB(target, touchInput, url,
    { shared: true, videoRenderingMode: 'canvas2d' }, supported, true);
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.enableWebRTC = false;
  rfb.clipboardBinary = false;
  rfb.focusOnClick = false;
  rfb.frameRate = 30;
  rfb.addEventListener('videocodecschange', (event) => {
    const available = event.detail?.codecs ?? [];
    const match = preferredCodecs.find((codec) => supported.includes(codec) && available.includes(codec));
    if (match !== undefined) rfb.streamMode = match;
  });
  rfb.addEventListener('disconnect', () => touchInput.remove(), { once: true });
  return rfb;
}
