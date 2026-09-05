export async function startCamera(video, { width = 1280, height = 720 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('no camera API in this browser — the page must be on localhost or https');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' }
  });

  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) {
    await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
  }

  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'camera permission denied — allow it in the browser, then reload';
    case 'NotFoundError':
      return 'no camera found';
    case 'NotReadableError':
      return 'camera is already in use by another app';
    case 'OverconstrainedError':
      return 'camera does not support the requested resolution';
    default:
      return err?.message || String(err);
  }
}
