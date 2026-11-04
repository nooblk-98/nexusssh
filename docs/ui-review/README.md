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
