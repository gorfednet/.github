/**
 * Properties of the starter files this repository ships, which only this
 * repository can check.
 *
 * `templates/verification-kit/templates/` is deliberately outside the kit
 * manifest — a project edits its copy, so tracking it would report drift
 * forever — which means a vendored kit has no templates/ directory at all.
 * An assertion about the shipped template therefore cannot live inside the
 * portable test suite: it passed here and failed with ENOENT in anal0g.org,
 * blackpixelrecords.com and gorfmusic.com simultaneously, within minutes of
 * v0.22.0 landing.
 *
 * Skipping when the file is absent would have been the quick fix and the wrong
 * one, because absent is the normal case everywhere except the one place the
 * assertion matters.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PLACEHOLDER_ID } from '../templates/verification-kit/lib/backlogSchema.mjs'

const templatePath = (name) =>
  fileURLToPath(new URL(`../templates/verification-kit/templates/${name}`, import.meta.url))

describe('the shipped backlog template', () => {
  it('uses the id the validator rejects by name', () => {
    // Otherwise the rejection looks for a placeholder that no longer exists,
    // the template sails through its own gate, and a project that copies it
    // and never edits it gets a green check describing a bug nobody has
    // (V52, V24).
    const shipped = JSON.parse(readFileSync(templatePath('backlog.json'), 'utf8'))
    assert.deepEqual(
      shipped.entries.map((entry) => entry.id),
      [PLACEHOLDER_ID],
    )
  })

  it('is otherwise a structurally complete entry', () => {
    // The placeholder has to satisfy every other rule, or it stops being a
    // usable example of what a real entry looks like.
    const [entry] = JSON.parse(readFileSync(templatePath('backlog.json'), 'utf8')).entries
    for (const field of ['title', 'status', 'assignee', 'userSymptom', 'evidence']) {
      assert.ok(entry[field], `template entry is missing ${field}`)
    }
  })
})
