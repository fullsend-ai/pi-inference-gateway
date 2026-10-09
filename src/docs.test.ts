// Documentation link check: every relative link and #anchor in the repo's markdown resolves, the
// README stays a landing page, and every docs/ page is reachable from it. No network: external
// (scheme-qualified) links are not fetched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const DOCS = join(ROOT, "docs");
const README_MAX_LINES = 120;

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
export function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The lines of a markdown file with fenced code blocks blanked out (line numbers kept). */
function proseLines(markdown: string): string[] {
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) {
        fence = marker;
        return "";
      }
      return line;
    }
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = undefined;
    }
    return "";
  });
}

/** Anchors GitHub generates for a file's headings, with -1, -2, ... for repeats. */
export function anchors(markdown: string): Set<string> {
  const result = new Set<string>();
  for (const line of proseLines(markdown)) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slug(heading);
    let anchor = base;
    for (let n = 1; result.has(anchor); n++) anchor = `${base}-${n}`;
    result.add(anchor);
  }
  return result;
}

/** Inline link targets outside fenced blocks and code spans. */
export function linkTargets(markdown: string): string[] {
  // A code span is a backtick run closed by a run of the same length, within one paragraph; an
  // unmatched run is literal text and hides nothing.
  const prose = proseLines(markdown)
    .join("\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ""))
    .join("\n\n");
  return [...prose.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? "");
}

function markdownFiles(): string[] {
  const top = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "PLAN.md", "CLAUDE.md"].map((f) => join(ROOT, f));
  return [...top.filter((f) => existsSync(f)), ...docsPages()];
}

function docsPages(): string[] {
  return readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(DOCS, f))
    .sort();
}

/** Problems with one link from `file`, or undefined when it resolves. */
function checkLink(file: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // http(s), mailto, ...
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  const resolved = path === "" ? file : resolve(dirname(file), decodeURIComponent(path));
  const where = `${relative(ROOT, file)}: ${target}`;
  if (!resolved.startsWith(ROOT)) return `${where} (outside the repository)`;
  if (!existsSync(resolved)) return `${where} (no such file)`;
  if (anchor === undefined || anchor === "") return undefined;
  if (!resolved.endsWith(".md")) return `${where} (anchor on a non-markdown file)`;
  if (!anchors(readFileSync(resolved, "utf8")).has(anchor)) return `${where} (no such heading)`;
  return undefined;
}

describe("docs: GitHub-style heading anchors", () => {
  it("drops backticks, parentheses and other punctuation, and hyphenates spaces", () => {
    assert.equal(slug("Request features (`compat`)"), "request-features-compat");
    assert.equal(slug("Thinking levels (`thinkingLevelMap`)"), "thinking-levels-thinkinglevelmap");
    assert.equal(slug("Gateway side: must-haves"), "gateway-side-must-haves");
    assert.equal(slug("Walkthrough (pi 1.0.2, mock gateway in Basic mode)"), "walkthrough-pi-102-mock-gateway-in-basic-mode");
    assert.equal(slug("Add the models `/v1/models` does not list"), "add-the-models-v1models-does-not-list");
    assert.equal(slug("Gateway limits below pi's catalog"), "gateway-limits-below-pis-catalog");
  });

  it("numbers repeated headings and ignores '#' lines inside fenced code", () => {
    const md = ["# Title", "## Usage", "```bash", "# not a heading", "```", "  ```", "## Inside an indented fence", "  ```", "## Usage"].join("\n");
    assert.deepEqual([...anchors(md)], ["title", "usage", "usage-1"]);
  });

  it("keeps every anchor unique when a repeated heading's suffix collides with a real heading", () => {
    const md = ["# Usage", "# Usage", "# Usage-1", "# Usage"].join("\n");
    assert.deepEqual([...anchors(md)], ["usage", "usage-1", "usage-1-1", "usage-2"]);
  });

  it("matches code spans by backtick-run length and ignores unmatched backticks", () => {
    const doubled = "Example: ``[a](double.md) with ` inside`` and [real](real.md).";
    assert.deepEqual(linkTargets(doubled), ["real.md"]);
    const unmatched = ["A stray ` backtick.", "", "A [link](kept.md) in the next paragraph and `[code](hidden.md)`."].join("\n");
    assert.deepEqual(linkTargets(unmatched), ["kept.md"]);
    const sameParagraph = "A stray ` backtick before [link](kept.md).";
    assert.deepEqual(linkTargets(sameParagraph), ["kept.md"]);
  });

  it("finds links outside code, including links whose text wraps a line", () => {
    const md = ["See [a\nwrapped link](x.md#y) and `[code](not-a-link.md)`.", "```", "[fenced](no.md)", "```"].join("\n");
    assert.deepEqual(linkTargets(md), ["x.md#y"]);
  });
});

describe("docs: links", () => {
  it("every relative link and #anchor in the markdown resolves", () => {
    const broken = markdownFiles().flatMap((file) =>
      linkTargets(readFileSync(file, "utf8")).flatMap((target) => checkLink(file, target) ?? []),
    );
    assert.deepEqual(broken, []);
  });

  it("every markdown path cited in a source comment exists", () => {
    const sources = readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const missing = sources.flatMap((f) => {
      const text = readFileSync(join(ROOT, "src", f), "utf8");
      return [...text.matchAll(/[\w./-]+\.md(?:#[\w-]+)?/g)]
        .map((m) => m[0])
        .flatMap((target) => checkLink(README, target) ?? []);
    });
    assert.deepEqual(missing, []);
  });
});

describe("docs: README is a landing page", () => {
  const readme = readFileSync(README, "utf8");

  it(`stays within ${README_MAX_LINES} lines`, () => {
    const lines = readme.trimEnd().split("\n").length;
    assert.ok(lines <= README_MAX_LINES, `README.md has ${lines} lines`);
  });

  it("links every docs/ page from its Next steps table", () => {
    const section = /^## Next steps\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1];
    assert.ok(section, "README.md has a '## Next steps' section");
    const linked = new Set(linkTargets(section).map((t) => resolve(ROOT, t.split("#")[0] ?? "")));
    const unlinked = docsPages().filter((page) => !linked.has(page)).map((page) => relative(ROOT, page));
    assert.deepEqual(unlinked, []);
  });

  it("every docs/ page opens with a link back to the README", () => {
    const missing = docsPages().filter((page) => {
      const opening = readFileSync(page, "utf8").split("\n\n").slice(0, 2).join("\n\n");
      return !linkTargets(opening).some((t) => resolve(dirname(page), t.split("#")[0] ?? "") === README);
    });
    assert.deepEqual(missing.map((page) => relative(ROOT, page)), []);
  });
});
