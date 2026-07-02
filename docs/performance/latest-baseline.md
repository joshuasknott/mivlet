# Fable Performance Baseline

Generated: 2026-07-02T23:06:37.009Z

## Environment

- Platform: win32 x64
- Node: v24.16.0
- pnpm: 10.15.0

## Timed Commands

| Command | Exit | Duration |
| --- | ---: | ---: |
| `pnpm build` | 0 | 30260 ms |

## Desktop Bundle

- JS total: 703.7 KiB raw, 207.4 KiB gzip
- CSS total: 134.9 KiB raw, 20.4 KiB gzip
- JS/CSS total: 838.6 KiB raw, 227.8 KiB gzip

### Largest JS/CSS Assets

| Asset | Type | Raw | Gzip |
| --- | --- | ---: | ---: |
| `apps/desktop/dist/assets/index-BkqqJJOh.js` | js | 312.9 KiB | 89.3 KiB |
| `apps/desktop/dist/assets/react-vendor-DTgtZFgi.js` | js | 184.3 KiB | 57.6 KiB |
| `apps/desktop/dist/assets/index-Dcm1hwYH.css` | css | 134.9 KiB | 20.4 KiB |
| `apps/desktop/dist/assets/SettingsPage-B9irym_O.js` | js | 71.0 KiB | 17.6 KiB |
| `apps/desktop/dist/assets/KnowledgePage-CToXC-kQ.js` | js | 39.0 KiB | 10.1 KiB |
| `apps/desktop/dist/assets/ProviderIcon-CtN0iMmY.js` | js | 24.5 KiB | 9.0 KiB |
| `apps/desktop/dist/assets/SchedulesPage-BAUI8oX1.js` | js | 22.3 KiB | 6.7 KiB |
| `apps/desktop/dist/assets/OnboardingPage-BMw6r1ye.js` | js | 14.9 KiB | 4.8 KiB |
| `apps/desktop/dist/assets/ConnectorsPage-Dch_R4Ve.js` | js | 8.0 KiB | 2.6 KiB |
| `apps/desktop/dist/assets/ApprovalPanel--gqo9S9U.js` | js | 8.0 KiB | 2.5 KiB |
| `apps/desktop/dist/assets/WarningCircle.es-ner6cRdN.js` | js | 5.6 KiB | 1.5 KiB |
| `apps/desktop/dist/assets/vendor-BSD_XLgc.js` | js | 4.6 KiB | 2.0 KiB |

## Limits

- This reports local build timings and static Vite output sizes only.
- It does not measure signed Tauri installer size, real WebView cold start, live provider latency, or production OAuth flows.
- Re-run on the same machine before comparing numbers across branches.
