export let motionRate = 1;

export function motionMs(ms: number): number {
  return document.documentElement.classList.contains("no-anim") ? 0 : Math.round(ms / motionRate);
}
export function setMotionRate(rate: number): void {
  motionRate = rate;
}

