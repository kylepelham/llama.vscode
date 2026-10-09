import * as vscode from 'vscode';
import {Application} from "./application";

// Fills the FIM ring with context from open tabs and from workspace files that share identifiers
// with the file being edited, so completions know the codebase without the user touching every file.

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const INDEX_GLOB = "**/*.{sql,cs,ts,tsx,js,jsx,mjs,py,rs,go,java,vb,cshtml,razor,ps1,kt,swift,c,cpp,h,hpp,php,rb,lua,sh,xaml,toml,md}";
const EXCLUDE_GLOB = "**/{node_modules,bin,obj,.git,dist,out,target,build,.vs,.idea,vendor,packages}/**";
const MAX_FILES = 8000;
const MAX_FILE_BYTES = 400000;
const COMMON_TERM_RATIO = 0.8;
// Terms in more than this share of files are language keywords, never worth prefix-expanding.
const KEYWORD_RATIO = 0.2;
const QUERY_DEBOUNCE_MS = 400;
const SWITCH_DEBOUNCE_MS = 100;
const TAB_CHUNKS = 10;
const WORKSPACE_CHUNKS = 8;
const PREFIX_MIN_CHARS = 4;
const PREFIX_EXPANSIONS = 20;
const CODE_SCHEMES = new Set(["file", "untitled"]);

const decoder = new TextDecoder("utf-8");

type TermCounts = Map<string, number>;

interface FileHit {
    fsPath: string;
    score: number;
    bestTerm: string;
}

interface SeedChunk {
    text: string;
    time: number;
    filename: string;
    seed: "tab" | "ws";
    lines: string[];
}

function tokenize(text: string): TermCounts {
    const counts: TermCounts = new Map();
    for (const match of text.matchAll(TOKEN_RE)) {
        const term = match[0].toLowerCase();
        counts.set(term, (counts.get(term) || 0) + 1);
    }
    return counts;
}

async function readText(uri: vscode.Uri): Promise<string | null> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) return null;

        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = decoder.decode(bytes);
        if (text.includes("\0")) return null;
        return text;
    } catch {
        return null;
    }
}

function chunkAround(lines: string[], centerLine: number, size: number): string[] {
    const start = Math.max(0, centerLine - Math.floor(size / 4));
    const end = Math.min(lines.length, start + size);
    return lines.slice(start, end);
}

function findLine(lines: string[], term: string): number {
    const needle = term.toLowerCase();
    const idx = lines.findIndex(l => l.toLowerCase().includes(needle));
    return idx < 0 ? 0 : idx;
}

function pathTail(fsPath: string): string {
    return fsPath.split(/[\\/]/).pop() ?? fsPath;
}

class WorkspaceIndex {
    private files = new Map<string, TermCounts>();
    private df = new Map<string, number>();
    ready = false;

    constructor(private log: (msg: string) => void) {}

    async build(): Promise<void> {
        const uris = await vscode.workspace.findFiles(INDEX_GLOB, EXCLUDE_GLOB, MAX_FILES);
        const started = Date.now();

        for (const uri of uris) {
            const text = await readText(uri);
            if (text !== null) this.update(uri.fsPath, text);
        }

        this.ready = true;
        this.log(`indexed ${this.files.size} files in ${Date.now() - started} ms, ${this.df.size} terms`);
    }

    update(fsPath: string, text: string): void {
        this.remove(fsPath);

        const terms = tokenize(text);
        for (const term of terms.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
        this.files.set(fsPath, terms);
    }

    remove(fsPath: string): void {
        const old = this.files.get(fsPath);
        if (!old) return;

        for (const term of old.keys()) {
            const n = (this.df.get(term) || 0) - 1;
            if (n <= 0) this.df.delete(term);
            else this.df.set(term, n);
        }
        this.files.delete(fsPath);
    }

    idf(term: string): number {
        const n = this.files.size;
        const df = this.df.get(term) || 0;

        if (df === 0 || df / n > COMMON_TERM_RATIO) return 0;
        return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    }

    isCommon(term: string): boolean {
        const df = this.df.get(term) || 0;
        return df / this.files.size > KEYWORD_RATIO;
    }

    // Partial identifier at the cursor: expand to the full terms it prefixes, most widely used first.
    expandPrefix(prefix: string): string[] {
        if (prefix.length < PREFIX_MIN_CHARS || this.isCommon(prefix)) return [];

        const hits: [string, number][] = [];
        for (const [term, df] of this.df) {
            if (term.startsWith(prefix) && term !== prefix) hits.push([term, df]);
        }
        hits.sort((a, b) => b[1] - a[1]);
        return hits.slice(0, PREFIX_EXPANSIONS).map(h => h[0]);
    }

    query(queryTerms: Map<string, number>, excludePaths: Set<string>): FileHit[] {
        const weights: [string, number][] = [];
        for (const [term, weight] of queryTerms) {
            const idf = this.idf(term);
            if (idf > 0) weights.push([term, weight * idf]);
        }
        if (weights.length === 0) return [];

        const scored: FileHit[] = [];
        for (const [fsPath, terms] of this.files) {
            if (excludePaths.has(fsPath)) continue;

            let score = 0;
            let bestTerm = "";
            let bestWeight = 0;
            for (const [term, weight] of weights) {
                const tf = terms.get(term);
                if (!tf) continue;

                score += weight * (tf / (tf + 1.2));
                if (weight > bestWeight) {
                    bestWeight = weight;
                    bestTerm = term;
                }
            }
            if (score > 0) scored.push({ fsPath, score, bestTerm });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, WORKSPACE_CHUNKS);
    }
}

export class ContextSeeder {
    private channel = vscode.window.createOutputChannel("llama-vscode context");
    private log = (msg: string) => this.channel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);
    private index = new WorkspaceIndex(this.log);
    private tabChunks: SeedChunk[] = [];
    private wsChunks: SeedChunk[] = [];
    private lastQueryKey = "";
    private queryTimer: NodeJS.Timeout | undefined;
    private switchTimer: NodeJS.Timeout | undefined;

    constructor(private app: Application) {}

    start(context: vscode.ExtensionContext): void {
        const sub = (d: vscode.Disposable) => context.subscriptions.push(d);

        sub(vscode.window.onDidChangeActiveTextEditor(() => this.onSwitch()));
        sub(vscode.window.tabGroups.onDidChangeTabs(() => this.onSwitch()));
        sub(vscode.workspace.onDidChangeTextDocument(e => {
            const active = this.codeEditor();
            if (active && e.document === active.document) this.scheduleQuery(QUERY_DEBOUNCE_MS);
        }));
        sub(vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.uri.scheme === "file") this.index.update(doc.uri.fsPath, doc.getText());
        }));
        sub(vscode.workspace.onDidDeleteFiles(e => e.files.forEach(u => this.index.remove(u.fsPath))));
        sub(vscode.workspace.onDidCreateFiles(e => {
            e.files.forEach(u => readText(u).then(t => { if (t !== null) this.index.update(u.fsPath, t); }));
        }));
        sub(vscode.workspace.onDidChangeWorkspaceFolders(() => this.index.build()));
        sub(this.channel);

        this.seedTabs()
            .then(() => this.index.build())
            .then(() => this.scheduleQuery(0))
            .catch(e => this.log(`startup failed: ${e}`));
    }

    private onSwitch(): void {
        clearTimeout(this.switchTimer);
        this.switchTimer = setTimeout(() => {
            this.seedTabs().then(() => this.scheduleQuery(0));
        }, SWITCH_DEBOUNCE_MS);
    }

    private scheduleQuery(delay: number): void {
        clearTimeout(this.queryTimer);
        this.queryTimer = setTimeout(() => this.runQuery().catch(e => this.log(`query failed: ${e}`)), delay);
    }

    private get chunkSize(): number {
        return this.app.configuration.ring_chunk_size;
    }

    // Output panels, diff views and the like are editors too; only real code documents count.
    private codeEditor(): vscode.TextEditor | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !CODE_SCHEMES.has(editor.document.uri.scheme)) return null;
        if (!this.app.configuration.isCompletionEnabled(editor.document)) return null;
        return editor;
    }

    private openTabDocuments(): vscode.Uri[] {
        const uris: vscode.Uri[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) uris.push(tab.input.uri);
            }
        }
        return uris;
    }

    private async seedTabs(): Promise<void> {
        try {
            const active = this.codeEditor();
            if (!active) return;

            const activePath = active.document.uri.toString();
            const chunks: SeedChunk[] = [];

            for (const uri of this.openTabDocuments()) {
                if (chunks.length >= TAB_CHUNKS) break;
                if (uri.toString() === activePath) continue;

                const doc = await vscode.workspace.openTextDocument(uri);
                if (!this.app.configuration.isCompletionEnabled(doc)) continue;

                const lines = doc.getText().split(/\r?\n/);
                if (lines.length < 3) continue;

                chunks.push(this.makeChunk(lines.slice(0, this.chunkSize), doc.fileName, "tab"));
            }

            this.tabChunks = chunks;
            this.applyRing();
        } catch (e) {
            this.log(`tab seeding failed: ${e}`);
        }
    }

    private queryTermsFor(document: vscode.TextDocument, position: vscode.Position): Map<string, number> {
        const weighted = new Map<string, number>();
        for (const [term, tf] of tokenize(document.getText())) weighted.set(term, Math.log(1 + tf));

        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!wordRange) return weighted;

        const partial = document.getText(new vscode.Range(wordRange.start, position)).toLowerCase();
        for (const term of this.index.expandPrefix(partial)) {
            if (!weighted.has(term)) weighted.set(term, 0.5);
        }
        return weighted;
    }

    private async runQuery(): Promise<void> {
        if (!this.index.ready) return;
        if (this.app.configuration.ring_n_chunks <= 0) return;

        const editor = this.codeEditor();
        if (!editor) return;

        const terms = this.queryTermsFor(editor.document, editor.selection.active);
        const key = [...terms.keys()].sort().join(" ");
        if (key === this.lastQueryKey) return;
        this.lastQueryKey = key;

        const exclude = new Set(this.openTabDocuments().map(u => u.fsPath));
        exclude.add(editor.document.uri.fsPath);
        const hits = this.index.query(terms, exclude);

        // Stable order by path so unchanged chunks keep their position and stay cached on the server.
        hits.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        const chunks: SeedChunk[] = [];
        for (const hit of hits) {
            const text = await readText(vscode.Uri.file(hit.fsPath));
            if (text === null) continue;

            const lines = text.split(/\r?\n/);
            const chunkLines = chunkAround(lines, findLine(lines, hit.bestTerm), this.chunkSize);
            if (chunkLines.length >= 3) chunks.push(this.makeChunk(chunkLines, hit.fsPath, "ws"));
        }

        this.wsChunks = chunks;
        const summary = hits.map(h => `${pathTail(h.fsPath)}(${h.bestTerm})`).join(", ") || "no hits";
        this.log(`query ${terms.size} terms -> ${summary}`);
        this.applyRing();
    }

    private makeChunk(lines: string[], filename: string, seed: "tab" | "ws"): SeedChunk {
        return { text: lines.join("\n") + "\n", time: Date.now(), filename, seed, lines };
    }

    private applyRing(): void {
        const extra = this.app.extraContext;
        const limit = this.app.configuration.ring_n_chunks;
        if (limit <= 0) return;

        const seeded = [...this.tabChunks, ...this.wsChunks].slice(0, limit);
        const seededTexts = new Set(seeded.map(c => c.text));
        const organic: { chunk: any; lines: string[] }[] = [];
        for (let i = 0; i < extra.chunks.length; i++) {
            const chunk = extra.chunks[i];
            if (chunk.seed || seededTexts.has(chunk.text)) continue;
            organic.push({ chunk, lines: extra.chunksLines[i] });
        }

        const keepOrganic = organic.slice(Math.max(0, organic.length - (limit - seeded.length)));
        const next: any[] = [...keepOrganic.map(o => o.chunk), ...seeded];
        const unchanged = next.length === extra.chunks.length && next.every((c, i) => c.text === extra.chunks[i].text);
        if (unchanged) return;

        extra.chunks = next;
        extra.chunksLines = [...keepOrganic.map(o => o.lines), ...seeded.map(c => c.lines)];
        extra.chunksHash = next.map(c => this.app.lruResultCache.getHash(c.text));
        this.app.llamaServer.updateExtraContext(extra.chunks);
        this.log(`ring: ${keepOrganic.length} organic + ${this.tabChunks.length} tab + ${this.wsChunks.length} workspace`);
    }
}
