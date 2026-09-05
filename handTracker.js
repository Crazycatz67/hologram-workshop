import { GestureRecognizer, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

export const HAND_CONNECTIONS = GestureRecognizer.HAND_CONNECTIONS;

// GestureRecognizer rather than raw HandLandmarker: it returns Closed_Fist and the other
// canned gestures already classified, runs two hands out of the box, and still exposes the
// raw landmarks that pinch detection needs (see gestures.js).
export async function createHandTracker({ numHands = 2 } = {}) {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  const recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands
  });

  let lastTimestamp = -1;

  return {
    // recognizeForVideo() throws unless each timestamp is strictly greater than the last,
    // so nudge it forward rather than letting a repeated frame time kill the loop.
    read(video, timestampMs) {
      const t = timestampMs <= lastTimestamp ? lastTimestamp + 1 : timestampMs;
      lastTimestamp = t;
      return toHands(recognizer.recognizeForVideo(video, t));
    },
    close() {
      recognizer.close();
    }
  };
}

// MediaPipe returns parallel arrays (landmarks[], handedness[], gestures[]). Flatten them
// into one object per hand — the shape the overlay and Phase 4's gesture logic want.
export function toHands(result) {
  return (result?.landmarks ?? []).map((landmarks, i) => ({
    landmarks,
    worldLandmarks: result.worldLandmarks?.[i] ?? null,
    handedness: result.handedness?.[i]?.[0]?.categoryName ?? 'Unknown',
    gesture: result.gestures?.[i]?.[0]?.categoryName ?? 'None',
    score: result.gestures?.[i]?.[0]?.score ?? 0
  }));
}
