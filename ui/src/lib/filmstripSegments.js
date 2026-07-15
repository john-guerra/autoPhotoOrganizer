/**
 * Group a loupe-filmstrip window into render segments so a burst reads the same
 * as it does in the feed: consecutive cells that are members of the SAME
 * expanded burst become one "run" (drawn tight, with a connecting line behind
 * them), and every other cell — a plain photo, a collapsed burst cover, or a
 * layout gap — is its own standalone "cell" segment.
 *
 * Pure: no DOM, no Svelte. The run-grouping is exactly the kind of off-by-one
 * seam (a member of a DIFFERENT burst, or a gap, must break the run) that is
 * cheap to unit-test and expensive to eyeball, so it lives here.
 *
 * @param {Array<{i:number, item:any}>} windowItems  the visible ± window, each
 *   carrying its real index `i` into the full items array
 * @param {Array<null | {count?:number, member?:boolean, stackId?:string}>} burstInfo
 *   parallel to the FULL items array (indexed by `cell.i`, not the window offset)
 * @returns {Array<
 *   | { type:'run', stackId:string, cells:Array<{i:number, item:any}> }
 *   | { type:'cell', cell:{i:number, item:any} }
 * >}
 */
export function filmstripSegments(windowItems, burstInfo) {
  const segments = [];
  let run = null;
  for (const cell of windowItems) {
    const real = cell.item && typeof cell.item.id === "number";
    const info = real ? burstInfo[cell.i] : null;
    if (info && info.member) {
      if (run && run.stackId === info.stackId) {
        run.cells.push(cell);
      } else {
        run = { type: "run", stackId: info.stackId, cells: [cell] };
        segments.push(run);
      }
    } else {
      // A cover, a plain photo, or a gap ends any open run — the connecting line
      // must not bridge across it.
      run = null;
      segments.push({ type: "cell", cell });
    }
  }
  return segments;
}
