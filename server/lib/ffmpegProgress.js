/**
 * Read ffmpeg's `-progress` stream.
 *
 * A conversion of a 337MB camcorder AVI takes minutes, and the user was given a
 * spinner and no number — no way to tell 10% from 90%, or a slow encode from a
 * hung one. ffmpeg will tell us exactly where it is, if we ask it to: `-progress
 * pipe:1` writes plain `key=value` lines, one block per update, ending in
 * `progress=continue` (or `progress=end`).
 *
 * Two things make this less trivial than a regex:
 *
 *  - The stream arrives in ARBITRARY CHUNKS. A block can be split mid-line, mid
 *    number, mid anything, so a parser that treats each chunk as whole lines will
 *    silently drop updates and occasionally read a truncated number as a real
 *    one. Hence the buffer: only complete lines are ever parsed.
 *  - `out_time_ms` is a LIE in most ffmpeg builds — it carries MICROseconds, not
 *    milliseconds (a long-standing upstream bug). Trusting the name makes every
 *    progress report 1000x too large, so the bar jumps instantly to 100% and
 *    stays there, which looks exactly like a finished job that never finishes.
 *    `out_time_us` is unambiguous; we prefer it and treat `out_time_ms` as the
 *    same unit, because that is what it actually contains.
 */

/**
 * @returns {{push: (text: string) => number|null}} push a chunk, get back the
 *   latest position IN SECONDS, or null if the chunk carried no complete update.
 */
export function createProgressParser() {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      // Keep the trailing partial line for the next chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let seconds = null;
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key !== "out_time_us" && key !== "out_time_ms") continue;
        // "N/A" shows up before the first frame is written.
        const micros = Number(value);
        if (!Number.isFinite(micros) || micros < 0) continue;
        seconds = micros / 1e6;
      }
      return seconds;
    },
  };
}
