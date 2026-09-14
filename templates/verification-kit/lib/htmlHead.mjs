/**
 * Read the parts of an HTML `<head>` that search engines and social scrapers
 * act on.
 *
 * Deliberately a regex reader rather than a DOM parser. The kit has to run in
 * repositories with no `node_modules` at all — four of the fleet's sites have
 * no `package.json` — so a dependency here would mean the check simply does
 * not exist for the sites most likely to need it.
 *
 * The tradeoff is that this reads markup, not a DOM: it cannot resolve what a
 * browser would do with malformed nesting. That is acceptable because every
 * assertion built on it is about whether a tag with a given value is *present
 * in the shipped bytes*, which is also all a scraper reads. Scrapers do not run
 * scripts, so a value injected at runtime is invisible to them and should be
 * invisible here too.
 */

/** Strip HTML comments so a commented-out tag never counts as present. */
function withoutComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '')
}

/** The `<head>` only. A `<meta>` in the body is not what a scraper reads. */
export function headOf(html) {
  const stripped = withoutComments(html)
  const match = stripped.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)
  // No explicit head element is legal markup; fall back to everything before
  // <body> rather than silently reporting an empty head, which would make every
  // "missing tag" assertion fire for the wrong reason.
  if (match) return match[1]
  const body = stripped.search(/<body\b/i)
  return body === -1 ? stripped : stripped.slice(0, body)
}

/**
 * Decode the entities that legitimately appear in attribute values.
 *
 * Kept minimal on purpose: this exists so a correctly-escaped `&amp;` in a URL
 * compares equal to the `&` a scraper will use, not to normalise arbitrary
 * markup.
 */
export function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function attr(tag, name) {
  const double = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
  if (double) return double[1]
  const single = tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'))
  if (single) return single[1]
  const bare = tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i'))
  return bare ? bare[1] : null
}

const tagsNamed = (head, tagName) => head.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? []

/**
 * Every occurrence, not the first.
 *
 * Two canonicals or two descriptions is its own defect — a scraper picks one
 * and which one is not something the page controls — so the callers need to see
 * duplicates rather than have them hidden by a lookup that stops at one.
 */
export function metaValues(head, key) {
  const found = []
  for (const tag of tagsNamed(head, 'meta')) {
    const name = attr(tag, 'name')
    const property = attr(tag, 'property')
    if ((name ?? '').toLowerCase() !== key.toLowerCase() && (property ?? '').toLowerCase() !== key.toLowerCase()) {
      continue
    }
    const content = attr(tag, 'content')
    if (content !== null) found.push(content)
  }
  return found
}

export function linkValues(head, rel) {
  const found = []
  for (const tag of tagsNamed(head, 'link')) {
    const value = (attr(tag, 'rel') ?? '').toLowerCase()
    // rel takes a space-separated list, so "icon" must match rel="shortcut icon".
    if (!value.split(/\s+/).includes(rel.toLowerCase())) continue
    const href = attr(tag, 'href')
    if (href !== null) found.push(href)
  }
  return found
}

export function titles(head) {
  return (head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/gi) ?? []).map((tag) =>
    decodeEntities(tag.replace(/<\/?title\b[^>]*>/gi, '')).trim(),
  )
}

export function htmlLang(html) {
  const tag = withoutComments(html).match(/<html\b[^>]*>/i)
  return tag ? attr(tag[0], 'lang') : null
}

/** Does the document carry a JSON-LD block, and what @type values are in it? */
export function jsonLdTypes(html) {
  const blocks =
    withoutComments(html).match(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? []
  const types = []
  for (const block of blocks) {
    const body = block.replace(/<\/?script\b[^>]*>/gi, '')
    for (const hit of body.match(/"@type"\s*:\s*"([^"]+)"/g) ?? []) {
      types.push(hit.replace(/.*"([^"]+)"$/, '$1'))
    }
  }
  return { blocks: blocks.length, types }
}
