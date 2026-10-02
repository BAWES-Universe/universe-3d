// Silent affects all in-world media. Busy remains a proximity-only availability choice.
export const SILENT_MEDIA_MESSAGE = 'No calls here. Your microphone, camera and screen sharing are off, and incoming calls are blocked.';
export const SILENT_MEDIA_EXIT_MESSAGE = 'After you leave, listening can resume if you stayed joined. Turn devices on again when you’re ready.';
export function activeMediaArea(areas) {
  return areas.find(area => area.action === 'silent') || areas.find(area => ['meeting','stage','audience'].includes(area.action)) || areas[0];
}
export function mediaAreaMessage(area) {
  if (area.action === 'silent') return SILENT_MEDIA_MESSAGE;
  return area.message || ({meeting:'Meeting area · connect when you’re ready',stage:'Stage · authorized speakers can broadcast',audience:'Audience · listen to the stage'}[area.action]) || '';
}

export function mediaAreaLabel(area) { return area.action === 'silent' ? `${area.name} · No calls` : area.name; }
