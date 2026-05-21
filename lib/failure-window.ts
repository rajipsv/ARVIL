/**
 * Focus analysis on the last CI failure region instead of the entire job log.
 */

const ANCHOR_MARKERS = [
  /##\[error\]/i,
  /CalledProcessError/i,
  /returned non-zero exit status/i,
  /subprocess\./i,
  /fatal:/i,
  /ninja: build stopped/i,
  /cmake error/i,
];

export interface FailureWindow {
  text: string;
  startLine: number;
  endLine: number;
  focused: boolean;
}

export function extractFailureWindow(content: string): FailureWindow {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) {
    return { text: content, startLine: 1, endLine: 1, focused: false };
  }

  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANCHOR_MARKERS.some((m) => m.test(lines[i]))) {
      anchor = i;
      break;
    }
  }

  if (anchor < 0) {
    return {
      text: content,
      startLine: 1,
      endLine: lines.length,
      focused: false,
    };
  }

  const lo = Math.max(0, anchor - 100);
  const hi = Math.min(lines.length, anchor + 30);
  return {
    text: lines.slice(lo, hi).join("\n"),
    startLine: lo + 1,
    endLine: hi,
    focused: true,
  };
}
