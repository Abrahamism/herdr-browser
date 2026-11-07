/**
 * Scripts injected into pages. Kept as plain strings: they run inside the browser,
 * not in Node, so they must not reference anything from this module.
 */

/**
 * The agent cursor: a closed shadow root on an anonymous host, marked with a short
 * attribute so the next invocation can paint it. Nothing on `window`, nothing readable
 * through the page's own tree - `closed` means even `shadowRoot` returns null.
 */
export const CURSOR_SCRIPT = `
(() => {
  if (document.querySelector('[data-hb-c]')) return 'already';
  const host = document.createElement('div');
  host.setAttribute('data-hb-c', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const point = document.createElement('div');
  point.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
    'margin:-2px 0 0 -2px', 'pointer-events:none', 'z-index:2147483647',
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.65))', 'transform-origin:2px 2px'
  ].join(';');
  point.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 2 L4 20 L9.2 15.2 L12.2 22 L15.4 20.4 L12.4 13.9 L19 13.6 Z" fill="#ff2d55" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  shadow.appendChild(point);
  const pos = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
  host.pos = pos;
  const paint = () => {
    point.style.left = pos.x + 'px';
    point.style.top = pos.y + 'px';
  };
  host.paint = (x, y) => {
    pos.x = x;
    pos.y = y;
    paint();
  };
  paint();
  const attach = () => document.documentElement && document.documentElement.appendChild(host);
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  addEventListener('mousemove', (event) => {
    pos.x = event.clientX;
    pos.y = event.clientY;
    paint();
  }, true);
  addEventListener('mousedown', (event) => {
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:fixed',
      'left:' + event.clientX + 'px',
      'top:' + event.clientY + 'px',
      'width:10px', 'height:10px', 'margin:-5px 0 0 -5px',
      'border:2px solid #ff2d55', 'border-radius:50%',
      'pointer-events:none', 'z-index:2147483646'
    ].join(';');
    shadow.appendChild(ring);
    const animation = ring.animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(6)', opacity: 0 }],
      { duration: 360, easing: 'ease-out' }
    );
    animation.onfinish = () => ring.remove();
  }, true);
  return 'installed';
})()
`

/**
 * The element scan, defined ONCE. A ref is a position in this exact list, so the snapshot
 * that printed `e5` and the command that clicks it can never disagree about which element
 * that is - the failure mode of an index scheme is two copies drifting apart.
 */
const SCAN_PRELUDE = `
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
    '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="switch"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]'
  ].join(',');
  const MAX_ITEMS = 500;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  // DOM order, visible only, capped: the ref table.
  const scan = () => Array.from(document.querySelectorAll(SELECTOR)).filter(visible).slice(0, MAX_ITEMS);
`

export function snapshotScript() {
  return `(() => {${SCAN_PRELUDE}
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const items = [];
  for (const [index, element] of scan().entries()) {
    const tag = element.tagName.toLowerCase();
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
    const item = { ref: 'e' + (index + 1), role, name };
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
})()`
}

export function resolveRefScript(ref) {
  return `
(() => {${SCAN_PRELUDE}
  const index = parseInt(String('${ref}').replace(/^e/, ''), 10) - 1;
  const element = scan()[index];
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
(() => {${SCAN_PRELUDE}
  const index = parseInt(String('${ref}').replace(/^e/, ''), 10) - 1;
  const element = scan()[index];
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
