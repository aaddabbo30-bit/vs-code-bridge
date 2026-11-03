# Claude Bridge

Pannello chat di Claude dentro VS Code. Le risposte arrivano da una chat di claude.ai collegata al connector "VS Code Bridge": premi *Copia prompt* nel pannello e incollalo in una chat (nuova o già esistente).

- `Ctrl+Alt+C` — chiedi a Claude (con la selezione)
- `Ctrl+Alt+E` — modifica la selezione con Claude (arriva un diff da accettare)
- Trascina file nel pannello (Shift se VS Code li apre invece di allegarli) o tasto destro → *Allega a Claude*
- *Agente* — Claude applica le modifiche da solo; *Annulla le modifiche* le toglie tutte per quella richiesta
- Lampadina sugli errori → *Chiedi a Claude di sistemarlo*
- ✨ nel pannello Git → messaggio di commit scritto da Claude
- Intestazione del pannello: cronologia, link alla chat di claude.ai, nuova chat con riassunto, memoria di progetto, nuova conversazione, configurazione
- Comando "Claude Bridge: Configura" — URL del server e token
