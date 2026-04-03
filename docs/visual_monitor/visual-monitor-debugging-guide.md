# Visual Monitor Debugging Guide

## Scope

This document is the practical debugging guide for the SocialClaw visual-monitor module.

It focuses on the operational questions that repeatedly matter in real use:

- how to choose screenshot frequency
- how to enable debugging mode
- why `auto ROI` should be tried first
- how to tune `auto ROI` boundary parameters
- how to debug by inspecting cached images
- when `manual ROI` must be recalibrated

This is not an architecture document. It is an operator-facing debugging guide.

## Recommended Debugging Order

Use this order when bringing the visual monitor into a stable state:

1. enable debugging mode first
2. start with `captureScope = roi`
3. prefer `roiStrategy = auto`
4. tune `autoRoi.coarse*Ratio` based on saved cache images
5. only fall back to `manual ROI` if `auto ROI` still cannot lock onto the correct chat area
6. if you use `manual ROI`, recalibrate whenever the WeChat window moves or changes size

The two core rules are:

- prefer `auto ROI`, because it adapts more naturally to the current window state
- use `manual ROI` only as a fallback, because it is highly sensitive to window position and size

## 1. How To Choose Screenshot Frequency

The frontend currently exposes screenshot cadence through `captureSensitivity`, which maps to different FPS profiles and capture schemes.

### `high`

Use this when:

- you are debugging
- the chat is changing quickly
- recall matters more than CPU cost

Current profile:

- `captureScheme = legacy`
- `idle = 4`
- `active_min = 5`
- `active_max = 6`
- `burst = 7`

This is the most aggressive mode and the best choice during ROI tuning.

### `medium`

Use this when:

- the setup is already mostly stable
- you want a daily default
- you still want good responsiveness

Current profile:

- `captureScheme = current`
- `idle = 2`
- `active_min = 4`
- `active_max = 5`
- `burst = 6`

This is the recommended day-to-day starting point.

### `low`

Use this when:

- the scene is already stable
- you want to reduce noise and resource usage
- you are no longer in the active debugging phase

Current profile:

- `captureScheme = current`
- `idle = 1`
- `active_min = 3`
- `active_max = 4`
- `burst = 5`

Do not use `low` while tuning ROI, because it slows the debugging loop too much.

## 2. Enable Debugging Mode First

The main debug switch is:

- `visualMonitor.testingMode = true`

When enabled, the backend preserves effective cached image artifacts for manual inspection instead of cleaning them up immediately.

There are three important behaviors to remember:

- debugging mode keeps effective `.png` images
- it does **not** keep every skipped raw frame
- this is intentional, because the valuable artifacts are the effective screenshots, not large amounts of useless noise

On the backend side, this maps to:

- `monitor.frame_cache.testing_mode = true`
- `monitor.frame_cache.keep_processed_frames = true`
- `monitor.frame_cache.cache_all_frames = false`

If you need extra long-lived debug dumps outside the normal frame-cache flow, there is also:

- `monitor.privacy.debug_dump_enabled = true`

But for ROI and screenshot-frequency tuning, `testingMode` is the main switch you want.

## 3. Where Cached Debug Images Are Stored

Each monitor run writes to an independent directory named like:

```text
monitor_frames_YYYYMMDD_HHMMSS
```

This directory is created under the configured cache root.

From the app-settings side, the typical location comes from:

- `storagePaths.cacheDir`

The backend field is:

- `monitor.frame_cache.cache_dir`

This is useful because every stop/start cycle creates a fresh debugging batch, which makes comparison easier.

The recommended debugging rhythm is:

1. enable debugging mode
2. start the monitor
3. reproduce the issue
4. stop the monitor
5. inspect the newest `monitor_frames_*` directory
6. adjust the settings
7. run again

## 4. Why Auto ROI Should Be Tried First

The recommended priority is:

1. `auto ROI`
2. `hybrid ROI`
3. `manual ROI`

Why:

- `auto ROI` is computed from the current WeChat window bounds
- it follows window-relative geometry
- it is easier to keep stable than an absolute-coordinate `manual ROI`

In the current implementation, `auto ROI` is not a learned detector. It is a geometry-based coarse crop resolver that depends primarily on:

- `autoRoi.coarseLeftRatio`
- `autoRoi.coarseTopRatio`
- `autoRoi.coarseWidthRatio`
- `autoRoi.coarseHeightRatio`

On the backend side, these correspond to:

- `monitor.roi_strategy.auto.coarse_left_ratio`
- `monitor.roi_strategy.auto.coarse_top_ratio`
- `monitor.roi_strategy.auto.coarse_width_ratio`
- `monitor.roi_strategy.auto.coarse_height_ratio`

So `auto ROI` is not something you should assume will be correct immediately. It usually needs tuning first.

## 5. How To Tune Auto ROI

When tuning `auto ROI`, use this setup:

1. set `testingMode = true`
2. set `captureSensitivity = high`
3. set `captureScope = roi`
4. set `roiStrategy = auto`
5. start the monitor and interact with a normal WeChat chat window
6. stop the monitor and inspect the newest cached images

What to check in the cache images:

- whether the ROI truly covers the right-side main chat pane
- whether the conversation title is cut off
- whether too much of the left session list is included
- whether the input box or blank space takes too much area
- whether the real message bubbles consistently stay inside the cropped region

How to adjust the parameters:

- if the crop starts too far left, increase `coarseLeftRatio`
- if the crop starts too far right, decrease `coarseLeftRatio`
- if the crop is too narrow, increase `coarseWidthRatio`
- if the crop is too wide and includes too much noise, decrease `coarseWidthRatio`
- if the crop starts too high or too low, adjust `coarseTopRatio`
- if the crop height is too short or too tall, adjust `coarseHeightRatio`

Then run another round and compare the next `monitor_frames_*` directory.

The goal is not a theoretically elegant ROI. The goal is an ROI that reliably covers the main chat area while minimizing side noise.

## 6. Check `/monitor/debug` In Addition To The Images

Besides the cached images, the fastest programmatic debug entry is:

```text
GET /monitor/debug
```

Useful fields include:

- `pipeline.last_roi`
- `pipeline.last_roi_source`
- `pipeline.last_roi_reason`
- `pipeline.last_decision_reason`
- `pipeline.last_vlm_parse_ok`
- `pipeline.events_emitted_total`
- `pipeline.processed_pending_frames`

How to interpret them:

- `last_roi_source = auto`: this run actually used auto ROI
- `last_roi_source = manual` or `manual_fallback`: auto ROI did not resolve successfully and the pipeline fell back to manual ROI
- `last_vlm_parse_ok = false`: the screenshot entered the pipeline, but parsing failed downstream
- if `processed_pending_frames` increases while `events_emitted_total` remains low, the issue is probably after the capture step
- if `last_decision_reason` keeps showing gate-related values, the issue is likely in the window gate before ROI even becomes relevant

## 7. When Re-Debugging Is Required

### Auto ROI

If you change the **WeChat window proportion**, `auto ROI` may need to be debugged again.

Why:

- auto ROI depends on window-relative geometry
- the `coarse*Ratio` values are tuned for a particular layout shape
- once the window proportion changes, the practical meaning of those ratios changes too

Typical triggers:

- making the WeChat window much wider or narrower
- changing the vertical proportion significantly
- switching to a different display-scaling or layout style

If the change is only a small window move while the window size stays exactly the same, auto ROI has a better chance of remaining stable, because it is resolved from the current window bounds.

### Manual ROI

If you are using `manual ROI`, then any WeChat window move or size change means you should recalibrate it.

This is a hard practical rule.

Why:

- manual ROI stores absolute coordinates
- moving the WeChat window breaks the alignment
- resizing the WeChat window also breaks the alignment

So for `manual ROI`:

- move the WeChat window -> recalibrate
- resize the WeChat window -> recalibrate

Do not expect old manual coordinates to remain valid after either action.

## 8. When To Fall Back To Manual ROI

Only fall back to `manual ROI` when one of these is true:

- the current WeChat layout is too unfriendly for auto ROI
- you have already tuned `autoRoi.coarse*Ratio`, but the system still cannot lock onto the main chat pane reliably
- you need a quick one-off hard lock for a fixed window layout

Recommended workflow:

1. place the WeChat window at the final position and size you want to use
2. do not move or resize it afterward
3. open the ROI overlay
4. manually select the true chat region
5. run the monitor and validate through the cached images

If you later move or resize the window, recalibrate immediately.

## 9. Recommended Stable Operating Playbook

For a new machine, a new display layout, or a newly changed WeChat window layout:

1. enable `testingMode`
2. set `captureSensitivity = high`
3. use `captureScope = roi`
4. try `roiStrategy = auto` first
5. inspect the newest `monitor_frames_*` directory
6. tune `autoRoi.coarse*Ratio`
7. once stable, switch daily use back to `medium`
8. only move to `manual ROI` if auto ROI still cannot be stabilized

For daily use:

1. keep the WeChat window layout as stable as possible
2. prefer the already tuned auto ROI setup
3. if the window proportion changes, re-check the cached images and retune auto ROI if needed
4. if you are using manual ROI, recalibrate after any move or resize

## 10. Bottom Line

The fastest path to a stable visual monitor is:

- enable debugging mode first
- use high screenshot frequency while tuning
- prefer auto ROI
- tune auto ROI based on real cached images
- only fall back to manual ROI when necessary

The two most important operating rules are:

- **if the WeChat window proportion changes, auto ROI may need to be debugged again**
- **if the WeChat window moves or resizes, manual ROI must be recalibrated**
