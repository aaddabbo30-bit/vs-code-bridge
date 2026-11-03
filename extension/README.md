# AI Bridge

An AI chat panel inside VS Code. The answers come from a web AI chat connected to the "VS Code Bridge" connector: press *Copy prompt* in the panel and paste it into a chat (new or existing).

- `Ctrl+Alt+C` — ask the AI (with the selection)
- `Ctrl+Alt+E` — edit the selection with the AI (you get a diff to accept)
- Drop files into the panel (hold Shift if VS Code opens them instead), or right click → *Attach for the AI*
- *Agent* — the AI applies changes on its own; *Undo changes* removes everything it did for that request
- Organize folders anywhere on your computer (e.g. Downloads): the AI proposes create / move / rename / Recycle Bin operations, you accept them, and you can undo them
- Light bulb on problems → *Ask the AI to fix it*
- ✨ in the Git panel → commit message written by the AI
- Panel header: history, link to the AI chat, new chat with a summary, project memory, new conversation, settings
- Command "AI Bridge: Configure" — server URL and token
