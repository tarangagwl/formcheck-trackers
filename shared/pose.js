/*
 * FormCheck shared tracking runtime.
 *
 * Handles camera access, MediaPipe Pose setup, the skeleton overlay and the
 * 500ms postMessage stream to the host app. Exercise pages supply only the
 * analysis logic: an onFrame() callback and a payload() builder.
 *
 * No audio, no coaching text, no on-screen stats. Data out only.
 */
(function (global) {
  "use strict";

  var LM = {
    NOSE: 0,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT: 31, RIGHT_FOOT: 32
  };

  var VIS_THRESHOLD = 0.6;
  var DRAW_VIS_THRESHOLD = 0.5;
  var SEND_INTERVAL_MS = 500;

  var CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
    [24, 26], [26, 28], [28, 30], [30, 32], [28, 32]
  ];

  /* ---------------------------------------------------------------- math */

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Angle of the vector from -> to, measured away from straight up (deg). */
  function angleFromVertical(from, to) {
    var vx = to.x - from.x;
    var vy = to.y - from.y;
    var mag = Math.hypot(vx, vy);
    if (mag === 0) return 0;
    var cos = Math.max(-1, Math.min(1, -vy / mag));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  /** Angle of the shoulder->hip line measured from horizontal (deg). */
  function angleFromHorizontal(a, b) {
    var dx = Math.abs(b.x - a.x);
    var dy = Math.abs(b.y - a.y);
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  /** Interior angle at origin between origin->a and origin->b (deg). */
  function angleBetween(origin, a, b) {
    var v1x = a.x - origin.x, v1y = a.y - origin.y;
    var v2x = b.x - origin.x, v2y = b.y - origin.y;
    var m1 = Math.hypot(v1x, v1y);
    var m2 = Math.hypot(v2x, v2y);
    if (m1 < 1e-6 || m2 < 1e-6) return 180;
    var cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  function verdictFromAverage(avg) {
    if (avg > 2.5) return "good";
    if (avg >= 1.5) return "needs work";
    return "bad";
  }

  function averageVisibility(landmarks, indices) {
    var sum = 0;
    for (var i = 0; i < indices.length; i++) {
      var lm = landmarks[indices[i]];
      sum += lm && typeof lm.visibility === "number" ? lm.visibility : 0;
    }
    return sum / indices.length;
  }

  /**
   * Picks the body side facing the camera and sticks with it unless the other
   * side becomes clearly more visible (avoids flicker between sides).
   */
  function createSideTracker(leftIndices, rightIndices) {
    var active = null;
    return function (landmarks) {
      var leftVis = averageVisibility(landmarks, leftIndices);
      var rightVis = averageVisibility(landmarks, rightIndices);
      if (active === null) {
        active = leftVis >= rightVis ? "left" : "right";
      } else if (active === "left" && rightVis > leftVis + 0.15) {
        active = "right";
      } else if (active === "right" && leftVis > rightVis + 0.15) {
        active = "left";
      }
      return { side: active, visibility: active === "left" ? leftVis : rightVis };
    };
  }

  /* ------------------------------------------------------------ messaging */

  function send(payload) {
    var json = JSON.stringify(payload);
    try {
      if (global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === "function") {
        global.ReactNativeWebView.postMessage(json);
        return;
      }
    } catch (e) { /* ignore */ }
    try {
      if (global.parent) global.parent.postMessage(json, "*");
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- runtime */

  /**
   * options.onFrame(landmarks, ctx) -> void
   *   ctx: { width, height, now } in pixel space of the analysed frame.
   * options.payload() -> object sent to the host every 500ms.
   * options.flagged() -> array of landmark indices to draw in red (optional).
   */
  function start(options) {
    var video = document.getElementById("video");
    var canvas = document.getElementById("canvas");
    var notice = document.getElementById("notice");
    var retry = document.getElementById("retry");
    var ctx = canvas.getContext("2d");

    function resize() {
      canvas.width = global.innerWidth;
      canvas.height = global.innerHeight;
    }
    global.addEventListener("resize", resize);
    resize();

    function drawSkeleton(landmarks, drawW, drawH, offsetX, offsetY) {
      var flagged = {};
      var list = typeof options.flagged === "function" ? options.flagged() : [];
      for (var f = 0; f < list.length; f++) flagged[list[f]] = true;

      function point(p) {
        return { x: p.x * drawW + offsetX, y: p.y * drawH + offsetY };
      }

      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(108, 99, 255, 0.85)";
      for (var i = 0; i < CONNECTIONS.length; i++) {
        var a = landmarks[CONNECTIONS[i][0]];
        var b = landmarks[CONNECTIONS[i][1]];
        if (!a || !b) continue;
        if ((a.visibility || 0) < DRAW_VIS_THRESHOLD) continue;
        if ((b.visibility || 0) < DRAW_VIS_THRESHOLD) continue;
        var pa = point(a), pb = point(b);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      for (var j = 0; j < landmarks.length; j++) {
        var lm = landmarks[j];
        if (!lm || (lm.visibility || 0) < DRAW_VIS_THRESHOLD) continue;
        var p = point(lm);
        ctx.beginPath();
        ctx.arc(p.x, p.y, flagged[j] ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = flagged[j] ? "#ff6b6b" : "#6bcb77";
        ctx.fill();
      }
    }

    var pose = new global.Pose({
      locateFile: function (file) {
        return "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/" + file;
      }
    });

    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    pose.onResults(function (results) {
      if (!canvas.width || !canvas.height) resize();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      var image = results.image;
      var vw = (image && image.width) || video.videoWidth;
      var vh = (image && image.height) || video.videoHeight;
      if (!vw || !vh) return;

      var scale = Math.max(canvas.width / vw, canvas.height / vh);
      var drawW = vw * scale;
      var drawH = vh * scale;
      var offsetX = (canvas.width - drawW) / 2;
      var offsetY = (canvas.height - drawH) / 2;

      if (image) ctx.drawImage(image, offsetX, offsetY, drawW, drawH);

      var landmarks = results.poseLandmarks;
      if (!landmarks || landmarks.length === 0) return;

      options.onFrame(landmarks, {
        width: vw,
        height: vh,
        now: performance.now()
      });

      drawSkeleton(landmarks, drawW, drawH, offsetX, offsetY);
    });

    var running = false;

    function loop() {
      if (video.readyState >= 2) {
        pose.send({ image: video }).catch(function () { /* ignore frame errors */ });
      }
      requestAnimationFrame(loop);
    }

    function startCamera() {
      if (running) return;
      running = true;
      notice.classList.remove("visible");

      var attempts = [
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: true, audio: false }
      ];

      (function next(i) {
        if (i >= attempts.length) {
          running = false;
          notice.classList.add("visible");
          return;
        }
        navigator.mediaDevices.getUserMedia(attempts[i]).then(function (stream) {
          video.srcObject = stream;
          return video.play();
        }).then(function () {
          requestAnimationFrame(loop);
        }).catch(function () {
          next(i + 1);
        });
      })(0);
    }

    if (retry) {
      retry.addEventListener("click", function () {
        running = false;
        startCamera();
      });
    }

    startCamera();
    setInterval(function () { send(options.payload()); }, SEND_INTERVAL_MS);
  }

  global.FormCheck = {
    LM: LM,
    VIS_THRESHOLD: VIS_THRESHOLD,
    dist: dist,
    angleFromVertical: angleFromVertical,
    angleFromHorizontal: angleFromHorizontal,
    angleBetween: angleBetween,
    verdictFromAverage: verdictFromAverage,
    averageVisibility: averageVisibility,
    createSideTracker: createSideTracker,
    start: start
  };
})(window);
