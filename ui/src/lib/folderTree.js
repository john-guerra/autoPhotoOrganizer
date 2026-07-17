/** Turns the flat list of folder groups the server returns (one row per folder
 * that has photos, keyed by absolute path) into the nested tree the sidebar
 * shows.
 *
 * The server cannot do this for us and shouldn't try: `folders` is a flat table
 * (abs_path UNIQUE, no parent_id), so the ONLY hierarchy that exists is the one
 * encoded in the path strings. Since getTreeNode already returns every folder
 * for a level in a single query, the client has all the data it needs and
 * expanding a folder row costs no fetch.
 *
 * Two rules, both borrowed from VS Code's explorer:
 *  - a folder with exactly one child and no photos of its own is JOINED with
 *    that child into a single row ("explorer.compactFolders")
 *  - the trie root is discarded and its compacted children become the roots, so
 *    folders on different volumes (sharing only "/") come out as separate roots
 *    instead of hanging off one useless "/" row. This is what lets a single
 *    library span several volumes.
 */

/** A row in the tree.
 * @typedef {object} FolderNode
 * @property {string} value     absolute path — the group value the feed knows
 * @property {string} label     path relative to the parent row; a compacted
 *                              chain like "Users/j/Pictures" when rows were joined
 * @property {number} ownCount  photos in this folder itself
 * @property {number} count     ownCount + every descendant (rolled up)
 * @property {boolean} isGroup  true when a real folder group exists at `value`;
 *                              false for a virtual ancestor invented by the trie
 * @property {FolderNode[]} children
 */

function splitPath(absPath) {
  return absPath.split("/").filter(Boolean);
}

/** @param {Array<{value: string, count: number}>} entries */
export function buildFolderTree(entries) {
  const root = makeNode("", "");
  for (const entry of entries ?? []) {
    let node = root;
    for (const segment of splitPath(entry.value)) {
      let child = node.childByName.get(segment);
      if (!child) {
        child = makeNode(segment, `${node.value}/${segment}`);
        node.childByName.set(segment, child);
      }
      node = child;
    }
    // The server groups by abs_path, so a value cannot repeat — but a defensive
    // += keeps a duplicate from silently dropping photos out of the totals.
    node.ownCount += entry.count;
    node.isGroup = true;
    // Keep the RAW server group value verbatim. `value` above is REBUILT from the
    // path segments (splitPath drops empty segments), so a rare abs_path with a
    // trailing slash — /a/b/c/ — loses it and no longer matches the group the
    // feed/seek key on. Jumps must use this exact string, or "jump to that folder"
    // silently finds no photos (only the scrubber, which keeps the raw value,
    // worked). Normal folders: groupValue === value.
    node.groupValue = entry.value;
  }
  return [...root.childByName.values()].map(finalize);
}

function makeNode(label, value) {
  return {
    value,
    label,
    ownCount: 0,
    isGroup: false,
    groupValue: null,
    childByName: new Map(),
  };
}

/** Compacts unary chains, rolls counts up, and drops the Map plumbing. */
function finalize(node) {
  // A folder with photos of its own is a real group: it has to keep its own row,
  // even when it has a single child, or it would lose its feed section.
  while (node.childByName.size === 1 && !node.isGroup) {
    const [child] = node.childByName.values();
    child.label = `${node.label}/${child.label}`;
    node = child;
  }
  const children = [...node.childByName.values()].map(finalize);
  return {
    value: node.value,
    // The exact server group value (verbatim abs_path); falls back to the rebuilt
    // `value` for the common case where they're identical. Used by the jump so it
    // hits the group the feed/seek actually key on. See buildFolderTree.
    groupValue: node.groupValue ?? node.value,
    label: node.label,
    ownCount: node.ownCount,
    count: node.ownCount + children.reduce((sum, c) => sum + c.count, 0),
    isGroup: node.isGroup,
    children,
  };
}

/** Every real folder group at or below `node`, in tree order. Used to resolve a
 * click on a virtual ancestor ("jump to the first group under here") and to fold
 * every group beneath one. */
export function descendantGroups(node) {
  const out = node.isGroup ? [node.value] : [];
  for (const child of node.children) out.push(...descendantGroups(child));
  return out;
}

/** Is this a row built by buildFolderTree (rather than a server tree node)? */
export function isFolderNode(node) {
  return Array.isArray(node?.children);
}

/** `absPath` with `prefix` removed from the front. */
export function relativeTo(absPath, prefix) {
  if (prefix && absPath.startsWith(`${prefix}/`)) {
    return absPath.slice(prefix.length + 1);
  }
  return absPath.replace(/^\//, "");
}

/** The chain of rows from a root down to the row for `value`, or [] if it isn't
 * in the tree. Compaction means the row for /a/b/c may be labelled "a/b/c", so
 * the chain cannot be derived from the path string alone — it has to be walked.
 * Used to reveal (and expand down to) the folder the feed is currently showing. */
export function chainTo(roots, value) {
  // Node values are rebuilt from path segments (no trailing slash); the feed hands
  // us the raw group value, which for a rare folder carries a trailing slash. Strip
  // it so reveal/Follow can still locate the row. See buildFolderTree.
  value = String(value).replace(/\/+$/, "");
  for (const node of roots) {
    if (node.value === value) return [node];
    if (value.startsWith(`${node.value}/`)) {
      const rest = chainTo(node.children, value);
      if (rest.length) return [node, ...rest];
    }
  }
  return [];
}
