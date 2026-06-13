'use strict';

/**
 * Profile Sandbox Module — secure CSP configuration and HTML sanitization
 * for user-supplied HTML/CSS/JS profile content.
 *
 * Renders MySpace-style profiles inside sandboxed iframes with strict CSP
 * headers that allow only safe rendering. Dangerous elements (scripts,
 * event handlers, external resources except safe embeds) are stripped.
 */

// ─── Allowed HTML tags (whitelist approach) ────────────────────────────────

const ALLOWED_TAGS = new Set([
  // Text structure
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'br', 'hr', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
  'dl', 'dt', 'dd', 'details', 'summary',

  // Text formatting
  'b', 'i', 'u', 's', 'em', 'strong', 'small', 'sub', 'sup',
  'mark', 'ins', 'del', 'abbr', 'cite',

  // Links & images (safe destinations only)
  'a', 'img',

  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',

  // Media
  'audio', 'video', 'source', 'figure', 'figcaption',

  // Widget containers
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
]);

const ALLOWED_ATTRIBUTES = new Set([
  // Global
  'id', 'class', 'style', 'title', 'lang', 'dir',

  // Links
  'href', 'target', 'rel',

  // Images
  'src', 'alt', 'width', 'height', 'loading',

  // Media
  'controls', 'autoplay', 'loop', 'muted', 'poster',

  // Tables
  'colspan', 'rowspan', 'scope', 'headers',

  // Lists
  'start', 'type',

  // Details
  'open',
]);

/**
 * Tags that are void elements (no closing tag)
 */
const VOID_ELEMENTS = new Set([
  'br', 'hr', 'img', 'input', 'source', 'col',
]);

/**
 * Allowed URL protocols for href/src attributes.
 * data: is allowed for inline images (base64).
 * https: is allowed for external images/media.
 */
const ALLOWED_PROTOCOLS = ['https:', 'data:', 'mailto:'];

// ─── HTML Sanitizer ───────────────────────────────────────────────────────

/**
 * Strip dangerous HTML content from user-supplied profile HTML.
 * Uses a tag/attribute whitelist approach.
 *
 * @param {string} html - Raw user-supplied HTML
 * @returns {string} Sanitized HTML
 */
function sanitizeHTML(html) {
  if (!html || typeof html !== 'string') return '';
  if (html.length > 50000) html = html.slice(0, 50000);

  // Strip script/style tags and their content
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  html = html.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  html = html.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
  html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  html = html.replace(/<math\b[^<]*(?:(?!<\/math>)<[^<]*)*<\/math>/gi, '');

  // Strip event handlers (onclick, onload, onerror, etc.)
  html = html.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Strip javascript: / data: URLs in href/src (except allowed data: for images)
  html = html.replace(/(\b(?:href|src)\s*=\s*["'])\s*javascript\s*:/gi, '$1#');
  html = html.replace(/(\bsrc\s*=\s*["'])\s*data:\s*text\/html/gi, '$1#');
  html = html.replace(/(\bhref\s*=\s*["'])\s*data:\s*/gi, '$1#');
  html = html.replace(/(\bbase\s*uri\s*=\s*)/gi, '$1');

  // Now parse tag by tag (simple regex-based tag-whitelist)
  // Strip disallowed tags but keep their content
  html = html.replace(/<\/?(\w+)([^>]*)>/gi, (match, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    const isClosing = match.startsWith('</');

    if (tag === 'style' || tag === 'script' || tag === 'iframe' ||
        tag === 'object' || tag === 'embed' || tag === 'svg' || tag === 'math') {
      return ''; // already stripped above
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Disallowed tag — keep its content but drop the tag wrapper
      return '';
    }

    if (isClosing) {
      if (VOID_ELEMENTS.has(tag)) return '';
      return `</${tag}>`;
    }

    // Filter attributes
    const safeAttrs = _filterAttributes(tag, attrs);
    if (VOID_ELEMENTS.has(tag)) {
      return safeAttrs ? `<${tag} ${safeAttrs}>` : `<${tag}>`;
    }
    return safeAttrs ? `<${tag} ${safeAttrs}>` : `<${tag}>`;
  });

  return html;
}

/**
 * Filter attributes for a given tag.
 * @param {string} tagName - Lowercase tag name
 * @param {string} attrsStr - Raw attribute string
 * @returns {string} Clean attribute string (or empty)
 */
function _filterAttributes(tagName, attrsStr) {
  if (!attrsStr || !attrsStr.trim()) return '';

  const safe = [];
  const attrRegex = /(\w[-:\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;

  while ((m = attrRegex.exec(attrsStr)) !== null) {
    const name = m[1].toLowerCase();
    let value = m[2] !== undefined ? m[2] : (m[3] || '');

    if (!ALLOWED_ATTRIBUTES.has(name)) continue;

    // Validate URLs for href/src
    if (name === 'href' || name === 'src') {
      const protocol = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)/);
      if (protocol) {
        if (!ALLOWED_PROTOCOLS.includes(protocol[1])) {
          // Block it — rewrite to #
          value = '#';
        }
      }
      // Relative URLs are okay for same-origin content
    }

    // Style: allow only safe CSS properties via inline styles
    if (name === 'style') {
      value = _sanitizeCSS(value);
    }

    // Target: only _blank, _self, _top, _parent
    if (name === 'target') {
      if (!['_blank', '_self', '_top', '_parent'].includes(value)) {
        value = '_blank';
      }
    }

    // Rel: noopener for safety
    if (name === 'rel') {
      value = 'noopener noreferrer';
    }

    safe.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
  }

  return safe.join(' ');
}

/**
 * Sanitize a CSS value — strip anything dangerous.
 * Allows: color, background, font, text-align, margin, padding,
 * border, width, height, display, opacity, transform, filter, etc.
 */
function _sanitizeCSS(css) {
  if (!css || typeof css !== 'string') return '';
  if (css.length > 4000) css = css.slice(0, 4000);

  // Strip CSS expressions, javascript: URLs, etc.
  css = css.replace(/expression\s*\(/gi, '');
  css = css.replace(/javascript\s*:/gi, '');
  css = css.replace(/vbscript\s*:/gi, '');
  css = css.replace(/url\s*\(\s*["']?javascript/gi, 'url(#)');
  css = css.replace(/-moz-binding\s*:/gi, '');
  css = css.replace(/behavior\s*:/gi, '');

  // Only allow a safe subset of CSS properties
  const allowedProps = [
    'color', 'background', 'background-color', 'background-image',
    'background-size', 'background-position', 'background-repeat',
    'font', 'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'text-align', 'text-decoration', 'text-shadow',
    'text-transform', 'letter-spacing', 'word-spacing', 'white-space',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-color', 'border-style', 'border-width', 'border-radius',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'display', 'position', 'top', 'right', 'bottom', 'left',
    'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
    'opacity', 'visibility', 'z-index',
    'transform', 'transform-origin', 'transition',
    'box-shadow', 'outline', 'cursor', 'list-style',
    'flex', 'flex-direction', 'flex-wrap', 'justify-content',
    'align-items', 'align-content', 'gap', 'order',
    'grid', 'grid-template', 'grid-column', 'grid-row', 'gap',
  ];

  // Simple CSS value sanitization — strip property:value pairs for disallowed props
  // and validate values (no position:fixed to prevent overlay attacks)
  const pairs = css.split(';').filter(Boolean);
  const safePairs = [];

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = pair.slice(0, colonIdx).trim().toLowerCase();
    const val = pair.slice(colonIdx + 1).trim();

    if (allowedProps.includes(prop)) {
      // Block position:fixed (prevents overlay takeovers)
      if (prop === 'position' && val === 'fixed') continue;
      // Block negative z-index (hiding elements behind other layers)
      if (prop === 'z-index' && parseInt(val) < 0) continue;
      safePairs.push(`${prop}:${val}`);
    }
  }

  return safePairs.join(';');
}

// ─── CSP Config ────────────────────────────────────────────────────────────

/**
 * Generate Content-Security-Policy headers for a sandboxed profile iframe.
 * This is the strictest reasonable CSP for user-generated HTML/CSS/JS.
 *
 * Returns an object suitable for use as helmet's contentSecurityPolicy directives.
 */
function sandboxCSP() {
  return {
    defaultSrc: ["'none'"],
    scriptSrc: ["'none'"],                    // No JS execution in the sandbox
    styleSrc: ["'unsafe-inline'"],             // Allow inline styles (user's custom CSS)
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    mediaSrc: ["'self'", "https:"],
    fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
    connectSrc: ["'none'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'self'"],                // Only embeddable on the same origin
    formAction: ["'none'"],                     // No form submissions
    baseUri: ["'none'"],
    upgradeInsecureRequests: true,
  };
}

/**
 * Return the sandbox attribute string for a profile iframe.
 */
function sandboxAttributes() {
  return 'allow-same-origin allow-scripts';
}

/**
 * Determine whether user-supplied JS should be allowed.
 * Phase 2: by default JS is NOT allowed — it's stripped.
 * Future phases may allow opt-in JS sandboxing via Web Workers / SES.
 */
function allowUserJS() {
  return false;
}

module.exports = {
  sanitizeHTML,
  _sanitizeCSS,
  sandboxCSP,
  sandboxAttributes,
  allowUserJS,
  ALLOWED_TAGS,
  WIDGET_TYPES: require('./profiles').WIDGET_TYPES,
};
