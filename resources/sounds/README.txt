Embedded notification sounds for the four-channel notification system.

Files:
  needs-you.wav  — plays when an agent transitions to "blocked" (rule 1).
                   Should be a short, urgent cue. ~300-500ms, sharp attack.
  done.wav       — plays when a run completes / fails while the user is not
                   looking (rule 2). Should feel like a quiet "ding" — pleasant
                   reassurance, not loud. ~300-500ms.

Format:
  RIFF/WAVE, 8-bit unsigned PCM, mono, 8000 Hz works fine for short cues.
  Higher quality (44.1 kHz, 16-bit) is also welcome — the renderer streams
  whichever encoding the HTMLAudioElement supports natively (which is all of
  the above).

Status:
  The shipped files are SILENT placeholder WAVs (~124 bytes each) so the wiring
  is real even when no sound is being authored. Replacing them with proper
  audio assets is a no-code change — just overwrite the files at this path.
