# Responsive UI review

Preserves the existing slate/blue light theme and zinc/blue dark theme, typography, shared buttons, and product workflows. No new dependencies or backend changes.

## Screenshots

Real Chromium renders using synthetic API fixtures (no production data). **Before** is development commit `2372f13`; **after** is this branch. Matching 320 × 800 mobile and 1440 × 800 desktop viewports, local fonts, and settled overlay animations. Images are committed so they remain available from the PR.

| View | Before | After |
| --- | --- | --- |
| Mobile Quick Connect | ![Before: cramped connection address](mobile-connect-before.png) | ![After: full-width protocol and readable address](mobile-connect-after.png) |
| Mobile command palette, light | ![Before: truncated server name](mobile-palette-light-before.png) | ![After: readable name and wrapping actions](mobile-palette-light-after.png) |
| Mobile command palette, dark | ![Before: truncated server name in dark mode](mobile-palette-dark-before.png) | ![After: readable name and actions in dark mode](mobile-palette-dark-after.png) |
| Desktop command palette | ![Before: crowded inline server actions](desktop-palette-light-before.png) | ![After: server name and actions on separate rows](desktop-palette-light-after.png) |

## Changes

- Mobile Quick Connect uses a separate protocol row to leave room for the address.
- Palette server names wrap instead of being squeezed by three action buttons.
- Shared drawers/dialogs contain keyboard focus, restore focus to their trigger, lock background scrolling, and handle nested Escape correctly.
- Menus support arrow/Home/End navigation, submenu entry/exit, focus restoration, viewport-aware placement, and height-limited scrolling. They render above drawers.
- Icon-only mobile settings navigation retains explicit accessible names, including Back; navigation targets are at least 44px tall.
- SFTP navigation wraps its path form onto its own row on phones; terminal search shrinks within its pane and has an accessible label.
- Fields/grids, batch output cards, long modal titles, and footers handle constrained space; shell/settings/modal heights respect the dynamic viewport.
- Focus outlines use the existing primary token; reduced-motion preferences suppress UI transitions/animations.

## Verification

`tests/e2e/ui-responsive.spec.ts` sweeps Home and all 16 settings routes at 320, 390, 768, 1024, and 1440px in light/dark modes, with targeted keyboard, nested-dialog, menu, SFTP, and sign-in checks. Existing populated settings-table, sidebar, Kubernetes console, cluster-folder, and routing tests cover related workflows. These UI checks use mocked APIs; they are not live SSH or cluster connectivity tests.

Run against a development web server with:

```sh
CI=1 E2E_URL=http://127.0.0.1:3100 npx playwright test ui-responsive settings-layout sidebar kubernetes-console kubernetes-routes kubernetes-folders
npm run typecheck
npm run lint
```

## 2026-11-04 follow-up: request lifecycle and status contrast

Baseline: `development` at `e377599` (including the earlier responsive review). No new dependencies, API contracts, schema, security policy, or deployment settings.

### Design system preflight

- `apps/web/app/globals.css`: slate/blue light and zinc/blue dark semantic surface, border, text and accent tokens; `--shadow`/`--shadow-lg`; mostly 6–8px radii; 8/12/16/24px spacing conventions (no standalone spacing/radius scale); primary-token focus-visible outline.
- `apps/web/components/ui.tsx`: Button, IconButton, Field, Check, SearchInput, Empty, Drawer, Dialog, DialogHost, menus, confirmDialog/promptDialog; notifications use `notify` in `lib/api.ts`.
- Settings use `components/settings/layout.tsx` and `components/settings/page-head.tsx`, `card`, `table-card`, `badge`, and `btn` classes. Heavy terminal/editor views already use dynamic imports.
- Reused installed React Query cancellation and native AbortController rather than introducing a library or custom request framework.

### Changes and evidence

- SFTP directory loads abort their predecessor and ignore cancelled success/error/finally updates; closing a tab cancels its listing. The delayed `/slow` → `/fast` regression failed on development (path reverted to `/slow`) and passes after the fix.
- `useApi` consumes React Query's AbortSignal. Leaving Operations with one stalled request previously left it outstanding (no requestfailed event within 3 seconds); now that request is aborted. Residual client requests in this fixture: **1 → 0**. This measures browser work only; aborting fetch does not guarantee server-side cancellation.
- Shared green/red badges retain their colour families but now pass 4.5:1 normal-text contrast on card surfaces: light green **2.92 → 6.33**, light red **4.02 → 5.39**, dark green **4.26 → 8.06**, dark red **3.18 → 5.56**. Dark amber and neutral badge text also use readable existing-family colours. Computed-style tests composite translucent badge backgrounds before calculating contrast.

Matching Chromium crops at 390 × 900, local fonts ready and animations disabled; before uses development CSS, after uses this branch. Only displayed before/after pairs are retained.

| Status badges | Before | After |
| --- | --- | --- |
| Light | ![Light before](2026-11-04/status-light-before.png) | ![Light after](2026-11-04/status-light-after.png) |
| Dark | ![Dark before](2026-11-04/status-dark-before.png) | ![Dark after](2026-11-04/status-dark-after.png) |

### Coverage and follow-ups

`review-lifecycle.spec.ts` covers both logic fixes plus contrast, focus, visibility and overflow on Operations. The existing `ui-responsive` sweep checks home/all 16 settings routes at 320, 390, 768, 1024 and 1440px in both themes. Populated settings tables, sidebar and Kubernetes specs run alongside it. These fixtures do not exhaust every drawer/menu/error/loading combination, terminal/editor split-view interaction, or every WCAG criterion. Real-device touch targets, live SSH/SFTP/cluster connectivity, backend throughput and production bundles were not measured in this round.

Backend inspection found per-server `resolveSettings` calls in `listServers`/`listServersPage`; batch resolution needs a database query-count benchmark and dedicated authorization/default-inheritance coverage before changing it. No unmeasured backend optimization was made. Primary-button contrast and a complete automated contrast inventory remain follow-ups; this round only certifies the tested readiness badges, not the entire UI.

README re-read: corrected the stale minor-image example from `0.3` to `0.4`; installer instructions, release badge and commands are unchanged. Changelog, Operations and Status are synced; no installer behavior changed.

### Verification results

- `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/unit`: **28 files / 202 tests passed**, with disposable synthetic DATABASE_URL/REDIS_URL and encryption/session/internal values supplied in the process environment. Initial unconfigured run could not import terminal-metrics; no production credentials were read.
- `CI=1 E2E_URL=http://127.0.0.1:3100 npx playwright test ui-responsive settings-layout sidebar kubernetes- review-lifecycle --output=/tmp/nexus-final-results`: **26 passed**. Initial overlapping browser runs collided in Playwright's output directory; the final run was sequential in a separate temporary output directory.
- `git diff --check`: passed. Local Markdown link targets in README, Changelog, Status, Operations, this review and the installer README all exist. External links and deployment commands were reviewed, not executed against production.
- Deleted fully merged `fix/responsive-ui-audit`, `fix/remove-all-approvals` and `fix/remove-ssh-approvals` branches locally/remotely after checking their tips against merged PRs #10/#9/#8 and ancestry in development. Preserved main/development and PR records.

## 2026-11-05 follow-up: primary actions and cluster checks

Baseline: `development` at `cbc90f71ef271119578b3424404d82824b264c99`.

### Design system preflight

- `apps/web/app/globals.css`: semantic slate/blue light and zinc/blue dark palettes, 8/12/16/24px spacing conventions, mostly 6–8px radii, `--shadow`/`--shadow-lg`, primary-token focus ring. No independent spacing/radius token scale.
- `components/ui.tsx`: Button/IconButton, Field/Check/SearchInput, Drawer/Dialog, promise-based `confirmDialog`/`promptDialog`, menus and toasts; `notify` is in `lib/api.ts`.
- Settings retain `components/settings/layout.tsx`, `page-head.tsx`, and `card`, `table-card`, `badge`, `btn` conventions. Existing dynamic imports already defer terminal/SFTP/editor/Kubernetes console and Monaco. Reused installed React Query's exact query-key invalidation and React refs; no custom request framework or dependencies.

### Changes and evidence

- Light primary blue uses existing palette shades `#2563eb` / hover `#1d4ed8`. Primary-button text contrast improves **3.68 → 5.17:1** (hover **5.17 → 6.70:1**). Dark stays unchanged at **6.97:1**, hover **9.82:1**. The shared token also improves blue action/link text. This is not a complete contrast certification of all UI colours.
- Connection checks invalidate only cluster metadata rather than every Kubernetes query. With the resource browser open, one check previously triggered **2 extra resource GETs; now 0**. Initial browse plus check: **4 → 2 resource GETs**. Explicit resource/log refresh and broad invalidation after profile mutations remain unchanged. No server-side latency or throughput claim is made.
- A delayed failure for cluster Alpha no longer appears as an inline error while browsing Beta. The response checks the current selection rather than the selection captured when the request began; a notification names Alpha instead.
- `tests/e2e/review-checks.spec.ts` reproduced all three baseline failures and now covers contrast (normal/hover, both themes), focus/visibility/overflow, request counts and the delayed-check race.

Matching synthetic Chromium renders at **1440 × 900**, local fonts ready, animations disabled. The before render uses development's original stylesheet; the static cluster-list markup is unchanged by this patch. Only the displayed pair is retained.

| Primary actions, light | Before | After |
| --- | --- | --- |
| Cluster list | ![Before](2026-11-05/primary-light-before.png) | ![After](2026-11-05/primary-light-after.png) |

### Verification and limitations

- `npm run lint`, `npm run typecheck`: passed.
- `npx vitest run tests/unit`: **28 files / 202 tests passed**, with disposable environment values only. Initial run rejected a too-short synthetic SESSION_SECRET; rerun used the required length.
- `CI=1 E2E_URL=http://127.0.0.1:3100 npx playwright test ui-responsive settings-layout sidebar kubernetes- review-lifecycle review-checks --output=/tmp/nexus-final`: **30 passed**. Includes home/all 16 settings routes, widths 320/390/768/1024/1440, both themes, populated table containment, sidebar and overlay keyboard behavior, cancellation and delayed-response regressions.
- `CI=1 E2E_URL=http://127.0.0.1:3100 npx playwright test kubernetes.spec review-checks --output=/tmp/nexus-additional`: **7 passed** (33 unique browser tests across both runs).
- `git diff --check`: passed. Local Markdown path targets in README, Changelog, Status, Kubernetes, this review and installer README all exist. External links and production deployment commands were reviewed, not executed.
- README re-read top to bottom: features now mention on-demand cluster checks; release badge, commands, installer and deployment settings unchanged. Kubernetes guide, Status and Changelog synchronized. No installer/API/schema/security/deployment behavior changed; no dependencies or unrelated restructuring.
- Removed fully merged PR #11's local/remote branch after verifying its tip against the PR and development ancestry. Preserved PR records and main/development.

This is a focused follow-up, not exhaustive verification of every route × state × overlay combination. The inherited route sweep uses mostly empty fixtures, with separate populated tables and Kubernetes workflows. Terminal/editor split-view interactions, every error/loading state, a full AA/tap-target inventory, live SSH/SFTP/cluster connectivity, real devices and backend throughput are not certified. Backend inspection retained existing bounded cluster/resource lists and expiring result storage; no unmeasured backend optimization was made. Remaining query-count/default-inheritance work noted on 4 November is still a follow-up.
