# Verification records

These are recorded development and deployment checks, not a hosted test service or a claim of support for every browser/device.

| Record | Scope |
| --- | --- |
| [Source verification](verification/source.json) | All 240 sprite cells matched their scaled source frames in an FFmpeg pixel-MD5 comparison; zero mismatches. |
| [Renderer verification](verification/renderer.json) | Source identity, complete chronological replay, interpolation, keyboard scrub endpoints, reduced motion, and missing-asset fallbacks. Recorded before later input-zone changes. |
| [Mobile regression verification](verification/mobile.json) | Current stacked-layout touch mapping, quick taps, drag release, scroll cancellation, retained slider selection, narrow layout, and unchanged desktop target samples. |
| [Lossless runtime build](verification/runtime-build.json) | Every pixel in all 24 frame/vector strip pairs matches its canonical atlas crop. |
| [Runtime browser verification](verification/runtime-browser.json) | Seven integer/fractional poses match the previous renderer pixel-for-pixel, including strip boundaries. Full replay under delayed loading, a four-page cache, desktop tracking, and mobile taps pass. |
| [Live Vercel verification](verification/runtime-live.json) | Chrome checks against the public production URL: all 240 frames, no giant-atlas requests, delayed loading without catch-up jumps, desktop neutral return, mobile tap response, and no JavaScript/WebGL errors. |

The strip runtime was verified on **20 September 2026**. The live run used Chrome with a 1440 × 900 desktop viewport and 390 × 844 touch emulation. The cache peaked at four decoded strip pairs (64,768,000 bytes); this excludes browser, GPU, and network overhead.

The renderer run measured a median display interval of 16.7ms in local Chromium at 1440 × 900. Timing depends on the host hardware and browser; it is not a performance guarantee. The mobile run used Chromium touch emulation at 390 × 844 and a 320px layout check. Physical iOS/Android verification was not performed.

## Manual check after changes

1. Start a local HTTP server and open `/?debug`.
2. Wait for the neutral poster to transition to the interactive scene.
3. Move across both desktop sides and through the middle; then enter the top quarter and confirm a neutral return.
4. Open the controls, scrub to both endpoints, and use Home / End on the focused slider.
5. Play Say hello and confirm it reaches the final frame. Use `__hero.drawnFrames` to inspect coverage.
6. Use a touch device or touch-emulating browser: tap upper/middle/lower scene positions, drag horizontally, release, and swipe vertically to scroll.
7. Check that the touch slider preserves its selection and a new gesture cancels a pending tap return.
8. Enable reduced motion and confirm automatic tracking stops while explicit controls remain usable.

`window.__hero` exists only when the `debug` query parameter is present. It exposes state, renderer/source details, frame coverage, timing samples, and `glError`; `seek(frame)` and `setMotion(enabled)` support visual comparisons.
