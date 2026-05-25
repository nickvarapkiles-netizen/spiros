// Thin wrapper around the browser's SpeechSynthesis API so the rest of the
// app doesn't poke at window/speechSynthesis directly.

export type TTSState = {
  supported: boolean;
  speaking: boolean;
  paused: boolean;
};

let activeUtterance: SpeechSynthesisUtterance | null = null;

export function ttsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

/** Pick a reasonable English voice. Prefer Apple natural voices, then any en-* default. */
export function pickVoice(): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const preferred = [
    "Samantha",
    "Karen",
    "Daniel",
    "Aaron",
    "Allison",
    "Ava",
    "Google US English",
  ];
  for (const name of preferred) {
    const v = voices.find((vv) => vv.name === name);
    if (v) return v;
  }
  const en = voices.find((v) => v.lang.startsWith("en"));
  return en ?? voices[0];
}

/** Speak the given text. Cancels anything currently speaking. */
export function speak(
  text: string,
  opts?: { onEnd?: () => void; rate?: number; pitch?: number },
): void {
  if (!ttsSupported() || !text.trim()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = opts?.rate ?? 1.05;
  u.pitch = opts?.pitch ?? 1.0;
  u.onend = () => {
    if (activeUtterance === u) activeUtterance = null;
    opts?.onEnd?.();
  };
  u.onerror = () => {
    if (activeUtterance === u) activeUtterance = null;
    opts?.onEnd?.();
  };
  activeUtterance = u;
  window.speechSynthesis.speak(u);
}

export function pause(): void {
  if (!ttsSupported()) return;
  window.speechSynthesis.pause();
}

export function resume(): void {
  if (!ttsSupported()) return;
  window.speechSynthesis.resume();
}

export function stop(): void {
  if (!ttsSupported()) return;
  window.speechSynthesis.cancel();
  activeUtterance = null;
}

export function isSpeaking(): boolean {
  if (!ttsSupported()) return false;
  return window.speechSynthesis.speaking;
}

export function isPaused(): boolean {
  if (!ttsSupported()) return false;
  return window.speechSynthesis.paused;
}

/** Speak an entire debrief: headline, then each section's title + body. */
export function speakDebrief(
  headline: string,
  sections: Array<{ title: string; body: string }>,
  opts?: { onEnd?: () => void; rate?: number },
): void {
  if (!ttsSupported()) return;
  const cleanBody = (s: string) =>
    s
      .replace(/[*_#`]/g, "")
      .replace(/\n+/g, ". ")
      .replace(/\s+/g, " ")
      .trim();
  const text =
    `${headline}. ` +
    sections
      .map((s) => `${s.title}. ${cleanBody(s.body)}`)
      .join(". ... ");
  speak(text, { rate: opts?.rate ?? 1.05, onEnd: opts?.onEnd });
}
