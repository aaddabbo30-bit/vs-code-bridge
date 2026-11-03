# VS Code Bridge

Claude (chat di claude.ai, piano incluso) dentro VS Code, senza API.

```
VS Code (estensione Claude Bridge) ──HTTPS──▶ Cloudflare Worker (questa repo, /server) ◀── connector MCP ── chat claude.ai
```

- `server/` — Cloudflare Worker + Durable Object. `/mcp/<TOKEN>` è il server MCP da aggiungere in claude.ai come custom connector; `/api/*` è usato dall'estensione (header `Authorization: Bearer <TOKEN>`, più `X-Bridge-Client` / `X-Bridge-Label` per distinguere le finestre di VS Code).
- `extension/` — estensione VS Code "Claude Bridge". Pacchetto pronto: [`dist/claude-bridge.vsix`](dist/claude-bridge.vsix).

## Cosa fa
- **Pannello chat** nella barra laterale (stile del tema di VS Code), con `Ctrl+Alt+C` (domanda) e `Ctrl+Alt+E` (modifica la selezione).
- **Allegati**: trascina file o cartelle nel pannello (da Explorer di VS Code o dal computer; se VS Code apre il file invece di allegarlo, tieni premuto Shift), oppure tasto destro → *Allega a Claude*. Il contenuto entra nella richiesta.
- **Modifiche**: un file (`propose_edit`) o più file insieme (`propose_changes`, un'unica revisione). Diff con Accetta/Rifiuta.
- **Modalità agente** (interruttore *Agente*): le modifiche vengono applicate subito; per ogni richiesta c'è un punto di ripristino e il pulsante *Annulla le modifiche*. Claude mostra il piano (`update_plan`) e riceve gli errori che VS Code segnala nei file cambiati, così li corregge da solo. I comandi chiedono sempre conferma (tranne i `git` di sola lettura).
- **Memoria di progetto** (`.claude-bridge/MEMORY.md`): Claude la legge all'inizio di ogni chat e la aggiorna con `save_memory`.
- **Nuova chat senza perdere il filo**: pulsante ⇄ → Claude scrive un riassunto (`.claude-bridge/HANDOFF.md`), la chat nuova lo riceve al primo giro.
- **Cronologia** delle conversazioni del pannello, ognuna collegabile al link della sua chat di claude.ai (si riapre con un clic); *Riprendi* prepara il riassunto di una conversazione vecchia per una chat nuova.
- **Chat esistenti**: *Copia prompt* → *Per una chat che esiste già*: incollalo in una chat dove hai già discusso il lavoro, e Claude usa quel contesto per agire in VS Code.
- **Lampadina sugli errori** (`Ctrl+.`): *Chiedi a Claude di sistemarlo*.
- **Messaggio di commit**: icona ✨ nel pannello Git.
- **Terminale**: Claude legge gli ultimi comandi del terminale integrato e il loro output (`get_terminal_output`).
- **Più finestre / più computer**: ogni finestra di VS Code ha il suo id; il prompt copiato lega la chat a quella finestra.

`.claude-bridge/` sta nella cartella del progetto: `MEMORY.md` si può tenere in git, `HANDOFF.md` di solito no.

## Deploy del server
Automatico: il repo è collegato a Cloudflare Workers Builds (root directory `server`), quindi ogni push su `main` pubblica il worker `vscode-bridge`. Il secret `BRIDGE_TOKEN` è impostato nel dashboard del worker (Settings → Variables and Secrets).

Deploy manuale (da un computer dove Node può eseguire programmi):
```
cd server
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put BRIDGE_TOKEN
```
Controllo: `https://<nome>.<subdominio>.workers.dev/health` → "VS Code Bridge: online".

## Connector in claude.ai
Custom connector, nome `VS Code Bridge`, URL `https://<worker>/mcp/<TOKEN>`, autenticazione *Nessun accesso*.

## Estensione
Pacchetto pronto: [`dist/claude-bridge.vsix`](dist/claude-bridge.vsix). Per ricrearlo:
```
cd extension
npx @vscode/vsce package --allow-missing-repository --skip-license -o ../dist/claude-bridge.vsix
```
VS Code → Extensions → … → Install from VSIX. Poi comando **Claude Bridge: Configura** (URL del worker + token).

## Uso
Nel pannello Claude premi *Copia prompt* e incollalo in una chat di claude.ai con il connector attivo (nuova o già esistente). Poi si lavora solo in VS Code.

## Test
```
cd server
echo BRIDGE_TOKEN=testtoken123 > .dev.vars
npx wrangler dev --port 8799 --ip 127.0.0.1   # in un altro terminale
node e2e-test.mjs                              # il server, con finte finestre di VS Code
node ../extension/test/integration.js          # l'estensione vera, con un VS Code simulato
```

## Tool MCP
follow_vscode, reply, update_plan, list_vscode_windows, get_editor_context, read_file, list_files, search, get_diagnostics, get_terminal_output, propose_edit, propose_changes, run_command, open_file, save_memory, save_handoff, get_result.
