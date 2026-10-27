# Source Notebook for DeepSeek Harness

Attach your own course files — lecture PDFs, slide decks, Word notes — to a chat
and the agent answers **from those passages only**, quoting the file and the
page, slide, or line range on every claim. It can also turn the material into
study guides and practice exams.

Two bundles live here, deliberately separate:

| Folder | Package | What it is |
|---|---|---|
| `dsh-source-notebook/` | `@local/dsh-source-notebook` | The plugin. A **Sources** tab in every chat, five agent tools, three slash commands, an HTTP read endpoint, and a grounding rule in the system prompt. |
| `notebook-preset/` | `@local/dsh-notebook-preset` | Optional **Notebook** agent mode: the same tools with a study-companion voice and a `notebook/` output rule. |

The plugin is a deployment-level row, so its tools exist in **every** agent mode.
The preset only supplies policy and voice; it mounts no notebook code.

## What you get

- **A Sources tab.** A third tab beside `Chat` and `Trajectory` at the top of the
  conversation. Selecting it drops the list down in place: every indexed file
  with its format and size, a warning on files that yielded no readable text, a
  path box to add one, and a `×` per row to remove one.
- **A status light on the tab.** The label reads `🔴 Sources` when the notebook
  holds nothing and `🟢 Sources · 3` when it does. Tabs accept display text only,
  so the light is text rather than a styled dot.
- **A blank-session form.** A brand-new chat has no header and therefore no tabs,
  so a one-line `Sources  [path]  Add` form sits in the composer dock until the
  first turn. That is how the first file gets attached.
- **Grounded answers.** The agent searches the notebook before answering, cites
  `file — locator` for every claim, and says plainly when the sources do not
  cover something instead of filling the gap from memory.

## Requirements

- **DeepSeek Harness Desktop**, or any web-UI profile. The plugin's client half
  is a browser module; a headless CLI profile loads the tools but shows no tab.
- **Nothing else.** No npm dependencies, no build step, no compiler. The
  extractor is written against `node:zlib` and `Buffer` only.
- **Optional: poppler's `pdftotext`** on `PATH` (or in a well-known install
  location). It is the only reader that reliably recovers reading order from
  slide-deck PDFs. Without it a built-in PDF reader runs and adds a warning when
  the result looks scrambled.

## Install

Pick one route. Both end with **a harness restart** and **a page refresh**.

### Option A — Plugin Manager (recommended)

1. Clone or unpack this repository somewhere permanent, for example
   `~/code/dsh-source-notebook`.
2. In DeepSeek Harness, open the **Plugin Manager** and use its **install
   bundle** action on the absolute path of `dsh-source-notebook/dsh-source-notebook`.
3. Optional: repeat for the `notebook-preset` folder to get the Notebook mode.
4. Restart the harness, then refresh the page.

The installer writes the profile's dependency and bundle list and links the
package into the profile, which is exactly what the manual route below does by
hand.

### Option B — edit the profile by hand

Edit the profile's `package.json` — `~/.dsh/profiles/<profile>/package.json`
(Windows: `C:\Users\<you>\.dsh\profiles\desktop\package.json`). **Merge** these
entries into what is already there; do not replace the file.

```json
{
  "dependencies": {
    "@local/dsh-source-notebook": "link:<path-to-repo>/dsh-source-notebook",
    "@local/dsh-notebook-preset": "link:<path-to-repo>/notebook-preset"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-source-notebook",
        "@local/dsh-notebook-preset"
      ]
    }
  }
}
```

Use forward slashes in the `link:` paths, even on Windows
(`link:C:/Users/you/code/dsh-source-notebook/dsh-source-notebook`).

Two rules:

- **Order matters.** `@deepseek-ai/dsh-base` must come first. The preset must come
  after `@deepseek-ai/dsh-web-app`, because the web app is what registers the
  preset registry that it mounts against.
- **`link:` is not a copy.** The profile points at this directory, so edits here
  take effect on the next load without reinstalling.

Then restart the harness and refresh the page. If it reports that a bundle cannot
be resolved, run the profile's install step once (`pnpm install` inside the
profile directory) so the `node_modules/@local/*` links are created.

### Verifying it loaded

The Sources tab should appear in a chat that already has at least one turn, and
the model should have `notebook_search` and friends available. Typing
`/source-notebook-list` answers with a JSON summary of the workspace's sources.

## Using it

1. Open a chat and select the **Sources** tab (or use the dock form in a brand
   new chat).
2. Type a path — relative to the workspace, a bare file name, or absolute — and
   press **Add**. The notebook extracts the text and indexes it.
3. Ask about the material. The agent searches, quotes, and cites.
4. Ask for a study guide or a practice exam; pick the **Notebook** mode in the
   mode picker if you installed the preset. Generated files go to `./notebook/`
   in the workspace, transcripts to `./notebook/transcripts/`.

### Agent tools

| Tool | Purpose |
|---|---|
| `notebook_add_source` | Index one file by path. |
| `notebook_remove_source` | Drop a file by its id. |
| `notebook_search` | Ranked passages for a query, each with source + locator. |
| `notebook_study_guide` | Every passage on a topic, in document order, under a character budget. |
| `notebook_practice_exam` | Passages per topic area, plus how many questions each area can support. |

### Slash commands

`/source-notebook-list`, `/source-notebook-add <path>`,
`/source-notebook-remove <id>`.

### Supported files

| Format | Labels in citations |
|---|---|
| PDF | `page N` |
| DOCX | `outline`, `notes`, then `lines A–B` |
| PPTX | `slide N`, plus speaker notes |
| `.txt` `.md` `.markdown` `.text` `.rst` `.csv` `.tsv` `.log` `.json` `.yaml` `.yml` `.html` `.htm` | `lines A–B` |

Scanned PDFs have no text layer: they are reported as unreadable rather than
silently indexed as empty. Encrypted PDFs are refused with a clear message.

## Where your sources live

One JSON file per workspace, beside the installed package:

```
<repo>/dsh-source-notebook/source-notebook/<workspace-name>-<hash>.json
```

A workspace is a directory, and every session opened in it shares one list, so
two workspaces cannot see each other's sources. The file records paths, not
contents; the text index itself is rebuilt in memory on first use after a
restart. The directory is git-ignored here, because it is runtime state.

Deleting the file (or removing a source from the tab) is the supported way to
forget a source. Your original files are never moved, renamed, or rewritten.

To uninstall, remove the bundle in the Plugin Manager (or delete the dependency
and bundle entries from the profile). Deleting `dsh-source-notebook/` together
with its `source-notebook/` state folder leaves no trace elsewhere.

## Configuration

Every key is optional; these are the defaults. Change them in the profile's
`cordis.patch.yml` or in this bundle's own patch file.

| Key | Default | Meaning |
|---|---|---|
| `maxSources` | `400` | Files a single workspace may hold. |
| `maxSourceBytes` | `25165824` | Per-file limit (24 MB) before it is refused. |
| `maxChunksPerSource` | `4000` | Chunks kept per file. |
| `searchResults` | `8` | Passages `notebook_search` returns by default. |
| `chunkChars` | `1200` | Window size for each searchable chunk. |

## How it works

```
browser ── GET /source-notebook/sources?session=…   (reads: no session event)
        └─ ctx.remote.commands.execute(…)           (add / remove: logged)
                        │
host: index.js ── registry (JSON per workspace) ── tools ──► model
                └─ extract.js  PDF/DOCX/PPTX/text → citations
```

The host owns everything: the client holds no index and extracts nothing.
Reads go over HTTP rather than through a slash command, because a command
execution is a **session event** and a view that repaints itself must not write
into the conversation. Add and remove stay on commands, where one recorded row
per real user action is the point.

The host half registers the route on the optional `webServer` service and the
client falls back to the command if the route is absent, so a profile without a
web server still works.

## Troubleshooting

**No Sources tab.** Refresh the page — the client half is a browser module.
A brand-new chat hides the header and tabs by design; use the dock form.

**A source is missing in another chat.** Sources are per workspace. Two chats in
the same directory share a list; two chats in different directories do not.

**PDF text comes out scrambled.** Install poppler and restart. The warning on
that row says `pdftotext` was unavailable.

**Edits to the plugin do nothing.** Host code (`index.js`, `extract.js`,
`cordis.patch.yml`) needs a harness restart; client code (`client.js`) needs a
page refresh. A session keeps the plugin revision it started with, so open a new
session after a change.

## Development

No build step: every file here is loaded in place.

```
dsh-source-notebook/
├── package.json        bundle manifest: dsh.bundle.patch, dsh.client, exports
├── cordis.patch.yml    the deployment-level row and its config
├── index.js            host half: registry, tools, commands, HTTP read
├── extract.js          PDF/DOCX/PPTX/text extraction, no dependencies
├── client.js           Sources tab, status light, blank-session add form
├── locale/en.json      title and description for the Plugin Manager
└── icon.svg            catalog icon

notebook-preset/
├── package.json
└── cordis.patch.yml    the Notebook agent mode
```

Conventions the code follows: the extractor imports `node:*` built-ins only,
because a bundle cannot resolve third-party packages; the client imports only
`react`; styling uses host theme tokens (`--dsw-alias-*`) and nothing else.

## Rights

No license is granted with this repository. It is shared for direct use; ask the
author before reusing the code elsewhere.
