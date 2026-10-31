/**
 * Scripts injected into pages. Kept as plain strings: they run inside the browser,
 * not in Node, so they must not reference anything from this module.
 */

export const CURSOR_SCRIPT = `
(() => {
  if ((window.__herdrBrowserCursorVersion || 0) >= 2) return 'already';
  window.__herdrBrowserCursorVersion = 2;
  document.querySelectorAll('[data-herdr-browser-cursor]').forEach((element) => element.remove());
  const NS = 'http://www.w3.org/1999/xhtml';
  const point = document.createElementNS(NS, 'div');
  point.setAttribute('data-herdr-browser-cursor', '1');
  point.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
    'margin:-2px 0 0 -2px', 'pointer-events:none', 'z-index:2147483647',
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.65))', 'transform-origin:2px 2px'
  ].join(';');
  point.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 2 L4 20 L9.2 15.2 L12.2 22 L15.4 20.4 L12.4 13.9 L19 13.6 Z" fill="#ff2d55" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const attach = () => document.documentElement && document.documentElement.appendChild(point);
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  const pos = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
  window.__hbPos = pos;
  const paint = () => {
    point.style.left = pos.x + 'px';
    point.style.top = pos.y + 'px';
  };
  window.__hbPaint = (x, y) => {
    pos.x = x;
    pos.y = y;
    paint();
  };
  paint();
  addEventListener('mousemove', (event) => {
    pos.x = event.clientX;
    pos.y = event.clientY;
    paint();
  }, true);
  addEventListener('mousedown', (event) => {
    const ring = document.createElementNS(NS, 'div');
    ring.setAttribute('data-herdr-browser-ripple', '1');
    ring.style.cssText = [
      'position:fixed',
      'left:' + event.clientX + 'px',
      'top:' + event.clientY + 'px',
      'width:10px', 'height:10px', 'margin:-5px 0 0 -5px',
      'border:2px solid #ff2d55', 'border-radius:50%',
      'pointer-events:none', 'z-index:2147483646'
    ].join(';');
    (document.documentElement || document.body).appendChild(ring);
    const animation = ring.animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(6)', opacity: 0 }],
      { duration: 360, easing: 'ease-out' }
    );
    animation.onfinish = () => ring.remove();
  }, true);
  return 'installed';
})()
`

const SNAPSHOT_BODY = `
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
    '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="switch"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]'
  ].join(',');
  const MAX_ITEMS = 500;
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  document.querySelectorAll('[data-herdr-browser-ref]').forEach((element) => {
    element.removeAttribute('data-herdr-browser-ref');
  });
  const items = [];
  let counter = 0;
  for (const element of document.querySelectorAll(SELECTOR)) {
    if (items.length >= MAX_ITEMS) break;
    if (!visible(element)) continue;
    const tag = element.tagName.toLowerCase();
    const ref = 'e' + (++counter);
    element.setAttribute('data-herdr-browser-ref', ref);
    const role = element.getAttribute('role') || tag;
    const type = element.getAttribute('type') || undefined;
    const name = clean(
      element.getAttribute('aria-label') ||
      element.innerText ||
      element.value ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      element.getAttribute('alt')
    ).slice(0, 120);
    const item = { ref, role, name };
    if (type) item.type = type;
    if (tag === 'a') item.url = element.getAttribute('href');
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      item.value = element.value;
      if (element.type === 'checkbox' || element.type === 'radio') item.checked = element.checked;
    }
    if (element.disabled) item.disabled = true;
    items.push(item);
  }
  return { title: document.title, url: location.href, items };
`

export function snapshotScript() {
  return `(() => {${SNAPSHOT_BODY}})()`
}

export function resolveRefScript(ref) {
  return `
(() => {
  const element = document.querySelector('[data-herdr-browser-ref="${ref}"]');
  if (!element) return { ok: false, error: 'ref ${ref} not found; run snapshot again' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { ok: false, error: 'ref ${ref} is not visible' };
  return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()
`
}

export function fillScript(ref, text) {
  return `
(() => {
  const element = document.querySelector('[data-herdr-browser-ref="${ref}"]');
  if (!element) return { ok: false, error: 'ref ${ref} not found; run snapshot again' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  const value = ${JSON.stringify(text)};
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: element.value };
})()
`
}

export function clickPointScript(x, y) {
  return `
(() => {
  const element = document.elementFromPoint(${x}, ${y});
  return { tag: element ? element.tagName.toLowerCase() : null };
})()
`
}
