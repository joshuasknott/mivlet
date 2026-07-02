# Fable Performance Baseline

Generated: 2026-07-02T22:34:35.179Z

## Environment

- Platform: win32 x64
- Node: v24.16.0
- pnpm: 10.15.0

## Timed Commands

| Command | Exit | Duration |
| --- | ---: | ---: |
| `pnpm build` | 0 | 48280 ms |

## Desktop Bundle

- JS total: 703.1 KiB raw, 198.5 KiB gzip
- CSS total: 135.2 KiB raw, 20.5 KiB gzip
- JS/CSS total: 838.2 KiB raw, 219.0 KiB gzip

### Largest JS/CSS Assets

| Asset | Type | Raw | Gzip |
| --- | --- | ---: | ---: |
| `apps/desktop/dist/assets/index-BIYLtPla.js` | js | 232.6 KiB | 68.0 KiB |
| `apps/desktop/dist/assets/react-vendor-CTuHNXXC.js` | js | 184.3 KiB | 57.6 KiB |
| `apps/desktop/dist/assets/icons-78ExV5UI.js` | js | 160.0 KiB | 34.9 KiB |
| `apps/desktop/dist/assets/index-CqXO2Smx.css` | css | 134.3 KiB | 20.3 KiB |
| `apps/desktop/dist/assets/SettingsPage-DDJ8lt6q.js` | js | 53.0 KiB | 13.3 KiB |
| `apps/desktop/dist/assets/ProviderIcon-DinrRqO7.js` | js | 20.0 KiB | 7.8 KiB |
| `apps/desktop/dist/assets/SchedulesPage-Emsu9imG.js` | js | 15.1 KiB | 4.6 KiB |
| `apps/desktop/dist/assets/KnowledgePage-BfSaBPsn.js` | js | 13.1 KiB | 3.5 KiB |
| `apps/desktop/dist/assets/OnboardingPage-Bvwo-qhV.js` | js | 11.1 KiB | 3.4 KiB |
| `apps/desktop/dist/assets/ConnectorsPage-nCCQW80N.js` | js | 8.0 KiB | 2.7 KiB |
| `apps/desktop/dist/assets/vendor-C_6aFv5F.js` | js | 4.6 KiB | 2.0 KiB |
| `apps/desktop/dist/assets/vendor-g_NWmXW7.css` | css | 885 B | 248 B |

## Limits

- This reports local build timings and static Vite output sizes only.
- It does not measure signed Tauri installer size, real WebView cold start, live provider latency, or production OAuth flows.
- Re-run on the same machine before comparing numbers across branches.
