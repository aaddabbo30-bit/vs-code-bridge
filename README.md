# VS Code Bridge

Your web AI chat (your plan included) inside VS Code, with no API keys.

```
VS Code (AI Bridge extension) ──HTTPS──▶ Cloudflare Worker (this repo, /server) ◀── MCP connector ── web AI chat
```

- `server/` — Cloudflare Worker + Durable Object. `/mcp/<TOKEN>` is the MCP server to add to the AI chat as a custom connector; `/api/*` is used by the extension (header `Authorization: Bearer <TOKEN>`, plus `X-Bridge-Client` / `X-Bridge-Label` to tell VS Code windows apart).
- `extension/` — the "AI Bridge" VS Code extension. Ready-made package: [`dist/ai-bridge.vsix`](dist/ai-bridge.vsix).

## What it does
- **Chat panel** in the side bar (styled with your VS Code theme), plus `Ctrl+Alt+C` (ask) and `Ctrl+Alt+E` (edit the selection).
- **Attachments**: drop files or folders into the panel (from VS Code's Explorer or from your computer; if VS Code opens the file instead of attaching it, hold Shift), or right click → *Attach for the AI*. Their content goes into the request.
- **Code changes**: one file (`propose_edit`) or several files at once (`propose_changes`, one review). Diff with Accept / Reject.
- **Agent mode** (*Agent* toggle): changes are applied at once; every request gets a restore point and an *Undo changes* button. The AI shows its plan (`update_plan`) and gets the problems VS Code reports in the changed files, so it fixes them itself. Commands always ask first (except read-only `git`).
- **Organize files anywhere on the computer** (e.g. Downloads): the AI looks with `list_dir` and proposes create / move / rename / Recycle Bin operations with `propose_file_ops`. You review them in the panel (in agent mode they are applied at once) and can undo them; nothing is ever overwritten or deleted for good, and system folders are refused. Files sent to the Recycle Bin are restored from the Recycle Bin.
- **Project memory** (`.ai-bridge/MEMORY.md`): the AI reads it at the start of every chat and updates it with `save_memory`.
- **New chat without losing the thread**: the ⇄ button → the AI writes a summary (`.ai-bridge/HANDOFF.md`) and the new chat gets it in its first round.
- **History** of the panel conversations, each one linkable to its web chat (reopens with one click); *Resume* prepares the summary of an old conversation for a new chat.
- **Existing chats**: *Copy prompt* → *For a chat that already exists*: paste it into a chat where you already discussed the work, and the AI uses that context to act in VS Code.
- **Light bulb on problems** (`Ctrl+.`): *Ask the AI to fix it*.
- **Commit message**: ✨ icon in the Git panel.
- **Terminal**: the AI reads the last commands of the integrated terminal and their output (`get_terminal_output`).
- **Several windows / computers**: every VS Code window has its own id; the copied prompt binds the chat to that window.

`.ai-bridge/` lives in the project folder: `MEMORY.md` can be kept in git, `HANDOFF.md` usually not.

## Server deployment
Automatic: the repo is connected to Cloudflare Workers Builds (root directory `server`), so every push to `main` deploys the `vscode-bridge` worker. The `BRIDGE_TOKEN` secret is set in the worker's dashboard (Settings → Variables and Secrets).

Manual deployment (from a computer where Node can run programs):
```
cd server
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put BRIDGE_TOKEN
```
Check: `https://<name>.<subdomain>.workers.dev/health` → "VS Code Bridge: online".

## Connector in the AI chat
Custom connector, name `VS Code Bridge`, URL `https://<worker>/mcp/<TOKEN>`, authentication *None*.

## Extension
Ready-made package: [`dist/ai-bridge.vsix`](dist/ai-bridge.vsix). To rebuild it:
```
cd extension
npx @vscode/vsce package --allow-missing-repository --skip-license -o ../dist/ai-bridge.vsix
```
VS Code → Extensions → … → Install from VSIX. Then run **AI Bridge: Configure** (worker URL + token). Earlier versions' token and settings are carried over automatically.

## Use
In the AI panel press *Copy prompt* and paste it into an AI chat with the connector on (new or existing). From then on you work in VS Code.

## Tests
```
cd server
echo BRIDGE_TOKEN=testtoken123 > .dev.vars
npx wrangler dev --port 8799 --ip 127.0.0.1   # in another terminal
node e2e-test.mjs                              # the server, with fake VS Code windows
node ../extension/test/integration.js          # the real extension, with a simulated VS Code
```

## MCP tools
follow_vscode, reply, update_plan, list_vscode_windows, get_editor_context, read_file, list_files, list_dir, search, get_diagnostics, get_terminal_output, propose_edit, propose_changes, propose_file_ops, run_command, open_file, save_memory, save_handoff, get_result.
