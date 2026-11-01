// Limits for voice rooms and streams, shared by the client and the server.
/** Hard cap on screen share and camera: 720p at 30 FPS (keeps server bandwidth predictable). */
export const STREAM_MAX = { height: 720, fps: 30, screenKbps: 2000, cameraKbps: 1200 };
/** Choices shown in settings (all at or below the cap). Lower ones help on weak connections. */
export const STREAM_CHOICES: [string, string][] = [
  ['360p15', '360p • 15 FPS'],
  ['480p30', '480p • 30 FPS'],
  ['720p30', '720p • 30 FPS'],
];
/** Target number of people in one voice channel at the same time. */
export const VOICE_TARGET = 100;
/** Above this many people in a voice channel we switch from peer-to-peer (mesh) to the media server (SFU). */
export const MESH_MAX = 6;
