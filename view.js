/* view.js — camera actions: the follow-camera easing loop and GM map rotation.
 * tickCamera eases the player view toward the party centroid on an on-demand rAF loop that stops
 * once settled (no idle power cost on the solar Pi); ensure/stopCameraLoop drive it. rotateMap turns
 * the GM view. Orchestration runs through the hub hooks (render/renderAndSync). The player-view-sync
 * actions (fitMap/rotatePlayerView/fitPlayerView) stay in app.js until the sync layer lands at step 14.
 */

import {
  canvas, hooks, isPlayer, playerCam, state,
} from "./state.js";
import {
  activeView, followView, viewTransform,
} from "./geometry.js";

const CAM_EASE = 0.15; // follow-camera smoothing: fraction of the gap closed per frame (higher = snappier)
const CAM_EASE_EPS = 0.5; // px: how close (center) counts as "arrived" so the easing loop can stop
const CAM_EASE_K_EPS = 0.001; // scale: how close (zoom) counts as "arrived"
let camEaseRaf = 0; // rAF handle for the on-demand camera-easing loop (0 = stopped)

// --- Follow-camera easing -------------------------------------------------------------------------
// The follow camera glides toward followView()'s target instead of snapping to it: each frame the eased
// camera closes a fraction of the gap (center + zoom). An on-demand rAF loop runs while catching up and
// stops once settled, so there's no idle power cost. viewTransform reads playerCam.ease; the movement hooks
// (glide, drag, sync, toggle) call ensureCameraLoop() to (re)start it when the party moves.
function tickCamera() {
  camEaseRaf = 0;
  if (!isPlayer || !playerCam.follow) { playerCam.ease = null; return; }
  const rect = canvas.getBoundingClientRect();
  const v = activeView();
  const ms = state.map.scale || 1;
  const target = followView(rect, v, ms);
  if (!target) { playerCam.ease = null; return; }
  if (!playerCam.ease) playerCam.ease = { ...target }; // first frame after enable: snap to the party, then ease
  playerCam.ease.cx += (target.cx - playerCam.ease.cx) * CAM_EASE;
  playerCam.ease.cy += (target.cy - playerCam.ease.cy) * CAM_EASE;
  playerCam.ease.k += (target.k - playerCam.ease.k) * CAM_EASE;
  const arrived =
    Math.abs(target.cx - playerCam.ease.cx) < CAM_EASE_EPS &&
    Math.abs(target.cy - playerCam.ease.cy) < CAM_EASE_EPS &&
    Math.abs(target.k - playerCam.ease.k) < CAM_EASE_K_EPS;
  if (arrived) playerCam.ease = { ...target }; // settle exactly so it stops drifting
  hooks.render(); // draws through viewTransform, which reads playerCam.ease
  if (!arrived) camEaseRaf = requestAnimationFrame(tickCamera);
}

function ensureCameraLoop() {
  if (isPlayer && playerCam.follow && !camEaseRaf) camEaseRaf = requestAnimationFrame(tickCamera);
}

function stopCameraLoop() {
  if (camEaseRaf) { cancelAnimationFrame(camEaseRaf); camEaseRaf = 0; }
  playerCam.ease = null;
}

// GM "rotate map": rotates the GM view in 90° steps and carries the orientation to the
// player too (overriding any independent player rotation). All content rides the view
// transform, so fog, tokens and stairs rotate with the map.
function rotateMap(deg) {
  state.view.rotation = ((((state.view.rotation || 0) + deg) % 360) + 360) % 360;
  state.playerView.rotation = state.view.rotation; // authoritative — overrides the player setting
  if (state.playerView.matchDM) {
    state.playerView.scale = state.view.scale;
    state.playerView.cx = state.view.cx;
    state.playerView.cy = state.view.cy;
  }
  hooks.renderAndSync();
}

export {
  tickCamera, ensureCameraLoop, stopCameraLoop, rotateMap,
};
