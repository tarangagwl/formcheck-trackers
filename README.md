# FormCheck Trackers

Three standalone camera pages that analyse weightlifting form from a side-on
view and stream the results to the FormCheck app. They are embedded in the app
as an iframe / WebView.

Each page does one job: watch the camera, count reps, score three categories,
and post the data out. No audio, no coaching text, no on-screen stats — the
host app owns all of that.

## Pages

| Page             | Scores                            |
| ---------------- | --------------------------------- |
| `squat.html`     | depth, torso angle, heel contact  |
| `deadlift.html`  | hip hinge, spine, lockout         |
| `overhead.html`  | torso lean, bar path, lockout     |

`index.html` links to all three for quick testing.

## Shared runtime

`shared/pose.js` handles camera access, MediaPipe Pose setup, the skeleton
overlay and the 500ms message loop. `shared/style.css` holds the (minimal)
styling. Each exercise page supplies only its measurement and scoring logic.

## Data sent to the host

Every 500ms, as a JSON string via `window.parent.postMessage(json, "*")`
(and `window.ReactNativeWebView.postMessage` when running inside a WebView).

Squat:

```json
{
  "exercise": "squat",
  "repCount": 5,
  "depthScore": 3, "torsoScore": 2, "heelScore": 3,
  "depthStatus": "good", "torsoStatus": "torso", "heelStatus": "good",
  "latestCue": "",
  "lastRepScores": { "depth": 3, "torso": 2, "heel": 3, "average": 2.67, "verdict": "good" },
  "phase": "standing"
}
```

Deadlift uses `hingeScore` / `spineScore` / `lockoutScore` with matching
statuses; overhead press uses `torsoScore` / `barPathScore` / `lockoutScore`.

Scores are 3 (good), 2 (needs work), 1 (bad). `lastRepScores` is `null` until
the first completed rep. `latestCue` is always an empty string — the app
decides what to say.

## Notes

- Knee tracking is not scored. It cannot be measured reliably from the side.
- Requires HTTPS (GitHub Pages qualifies) for camera access.
- MediaPipe Pose is loaded from a CDN; no build step.
