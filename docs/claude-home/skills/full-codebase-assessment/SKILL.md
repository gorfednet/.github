---
name: full-codebase-assessment
description: >-
  Full-repo quality pass for BinderCurve: simplify, refactor, security, WCAG
  2.1 AA, W3C validation. Use for dedicated assessment runs in the bindercurve.com
  monorepo (SPA + packages/api + packages/worker).
---

# Full codebase assessment

**Stack:** React 19 + Vite + TypeScript SPA at `/`; platform API (`packages/api`) and worker (`packages/worker`) on Gordon Docker. Release/deploy context: `.claude/skills/_shared/release-stack.md` in the bindercurve.com repo.

You are a principal engineer doing a **full-repo quality pass**. Work **creatively but evidence-based**: form hypotheses, verify in code, then change only what improves clarity, safety, maintainability, or compliance. Prefer **small, coherent commits of intent**. Do not expand scope into new features unless required to fix a defect.

## 1. Orientation and inventory (read-only first)

- Map architecture: `src/Root.tsx`, `src/shell/route.ts`, `/{tcg}` routing (Builder, Shop, Feed news/video, Play events/pods/trackers), `packages/api`, `packages/worker`, `infra/docker-compose.yml`.
- **Results freeze regressions:** full-restore boot must start with `leftPane: closed` (`useWorkbenchEdgeLayout.ts`); deck hydration must call `setLeftPane('closed')`; `useSharedInView` syncs visible rows on mount.
- List **risk surfaces**: paste/import, share URLs, `localStorage`, cookies, affiliate/outbound links, third-party card APIs, platform auth routes, **Trove camera scan** (nginx Permissions-Policy + CSP), **Watch alerts** (client-only v1), **service degraded banner**, shopping-list platform merge.
- **Accessibility-sensitive** zones: builder stepper, swap modal, deck tabs, shopping list dock, Trove line drawer, price charts, account/currency settings, help rails.

## 2. Simplification and refactoring

- Find duplication, dead code, and accidental complexity across `src/` and `packages/`.
- Prefer explicit TypeScript at boundaries; remove unsafe `any` unless documented.
- Match existing conventions; no style-only rewrites.
- Performance: fix measurable issues (re-renders, bundle hot paths); avoid micro-optimization theater.

## 3. Security and privacy

- Validate external data (API JSON, query params, `localStorage`) with safe parsing.
- No secrets in client bundles; Vite env vars documented in `.env.example` only.
- XSS: `dangerouslySetInnerHTML`, dynamic `href`/`src` from API data.
- Run `npm run lint` and relevant contract tests (`test:security`, `test:gating`).

## 4. Documentation and comments

- Update comments/README where behavior changed; remove stale comments.
- User-facing copy: `.claude/rules/brand-voice.md`, `user-prose.md`. Never touch owner-locked `RESULTS_EMPTY_*` without explicit user ask.

## 5. Accessibility (WCAG 2.1 Level AA)

Blocking for shipped UI:

- Semantic HTML, heading order, meaningful `alt`, contrast, focus rings.
- Full keyboard access; modals trap focus; `aria-*` only where needed.
- Labels and errors on forms; predictable navigation.
- Run `npm run test:accessibility-ui` when UI changed.

## 6. W3C validation

- HTML shell + critical client patterns; fix invalid nesting and duplicate IDs.
- Run `npm run validate:shell` for shell contract; pair with `npm run test:accessibility-ui` for a11y anchors.
- CSS spec violations that break parsers or a11y.
- Document benign warnings vs must-fix in the PR/summary.

## 7. Verification before you finish

- `npm run lint`, `npm run build` (or `npm run deploy:check -- --skip=test:scryfall-ping` for full SPA gate).
- Contract layer when commerce/Trove/analytics touched: `test:analytics`, `test:help-content`, `test:skeleton-loaders`, `test:user-journey-manifest`.
- Supplemental security: `npm run test:security`, `npm run test:gating` (not in deploy-check).
- `npm run smoke` if dist/markers changed.
- Platform changes on server: `npm run smoke:platform:api` (manual, not in deploy-check).
- Trove sell / platform prices: `troveSellOffers.test.ts`, `useTroveLinePlatformPrice.test.ts`, Gordon smoke for CK buy fields.

Summarize in **Outcome**: Simplify / Security / A11y / Validation / Docs. List **risks and follow-ups** honestly.

## Constraints

- Minimal diffs; no unrelated refactors.
- Do not commit secrets; do not weaken tests for convenience.
- Uncertain after search → say so and propose the smallest safe next step.

## How to use

- Run `/full-codebase-assessment` in a fresh session in the bindercurve.com repo. Sonnet does sections 2 and 4 to 6. Fable does section 3, and the `reviewer` reads the diff.
- Optional follow-up: *"Start with a read-only severity-ranked report, then implement fixes in order."*
