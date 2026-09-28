interface ShellSegment {
    raw: string;
    tokens: string[];
    next?: ";" | "&&" | "||" | "|";
}

/** Only literal simple commands are statically authorizable; expansion is never executed. */
export function parseShellCommand(command: string): {segments: ShellSegment[]; literal: boolean} {
    const segments: ShellSegment[] = [];
    let tokens: string[] = [];
    let word = "";
    let inWord = false;
    let quote: "single" | "double" | undefined;
    let literal = true;
    let start = 0;
    let needsCommand = false;
    const finishWord = () => {
        if (inWord) tokens.push(word);
        word = "";
        inWord = false;
    };
    const finishSegment = (end: number) => {
        finishWord();
        if (tokens.length) segments.push({raw: command.slice(start, end).trim(), tokens});
        tokens = [];
    };
    for (let i = 0; i < command.length; i++) {
        const char = command[i]!;
        if (char === "\\" && quote !== "single") {
            const next = command[++i];
            if (next === undefined) { literal = false; break; }
            if (next === "\n") continue;
            // In double quotes Bash only removes a backslash before these characters.
            if (quote === "double" && !['$', '`', '"', "\\"].includes(next)) word += "\\";
            word += next;
            inWord = true;
            continue;
        }
        if (char === "'" && quote !== "double") {
            quote = quote === "single" ? undefined : "single";
            inWord = true;
            continue;
        }
        if (char === '"' && quote !== "single") {
            quote = quote === "double" ? undefined : "double";
            inWord = true;
            continue;
        }
        if (quote !== "single" && (char === "$" || char === "`")) literal = false;
        if (!quote) {
            if (("<>(){}*?[]~".includes(char) || (char === "&" && command[i + 1] !== "&")) || (char === "#" && !inWord)) literal = false;
            const pair = command.slice(i, i + 2);
            if (char === ";" || char === "|" || char === "\n" || pair === "&&") {
                const hadCommand = inWord || tokens.length > 0;
                if (char === "\n" && !hadCommand && needsCommand) continue;
                if (!hadCommand && (needsCommand || char !== "\n")) literal = false;
                finishSegment(i);
                if (segments.length) segments[segments.length - 1]!.next = pair === "&&" || pair === "||" ? pair : char === "|" ? "|" : ";";
                needsCommand = char === "|" || pair === "&&";
                if (pair === "&&" || pair === "||") i++;
                start = i + 1;
                continue;
            }
            if (/\s/.test(char)) { finishWord(); continue; }
        }
        word += char;
        inWord = true;
        needsCommand = false;
    }
    if (quote || needsCommand) literal = false;
    finishSegment(command.length);
    // Control structures and assignments cannot be authorized as literal argv.
    if (segments.some(({tokens}) => !tokens[0] || /[=]/.test(tokens[0]) ||
        ["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "!", "time"].includes(tokens[0]))) literal = false;
    return {segments, literal: literal && segments.length > 0};
}

export function splitShellSubCommands(command: string): string[] {
    return parseShellCommand(command).segments.map(segment => segment.raw);
}

const READ_ONLY_COMMANDS = new Set([
    "cat", "cd", "cut", "df", "du", "echo", "false", "grep", "head", "ls",
    "pwd", "rg", "sort", "stat", "tail", "test", "tree", "true", "tr",
    "uname", "uniq", "wc", "which", "whoami", "date", "file",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    "describe", "diff", "grep", "log", "ls-files", "rev-parse", "show", "status",
]);

/** This syntax guard is not a permission parser or a process-isolation boundary. */
export function hasShellBackgroundOperator(command: string): boolean {
    function scan(text: string, expansionsOnly = false): boolean {
        let index = 0;
        let background = false;
        type HereDoc = {delimiter: string; quoted: boolean; stripTabs: boolean};

        function quoted(quote: "'" | '"', ansi = false): void {
            index++;
            while (index < text.length) {
                if (text[index] === quote) { index++; return; }
                if (text[index] === "\\" && (quote === '"' || ansi)) {
                    // Within double quotes only these characters can be escaped.
                    if (ansi || /[$`"\\\n]/.test(text[index + 1] ?? "")) { index += 2; continue; }
                }
                if (quote === '"' && expansion()) continue;
                index++;
            }
        }

        function arithmetic(): void {
            let depth = 2;
            index += 2;
            while (index < text.length && depth > 0) {
                if (expansion()) continue;
                const char = text[index];
                if (char === "'" || char === '"') { quoted(char); continue; }
                if (char === "\\") { index += 2; continue; }
                if (char === "(") depth++;
                if (char === ")") depth--;
                index++;
            }
        }

        function parameter(): void {
            index += 2;
            let depth = 1;
            while (index < text.length && depth > 0) {
                if (expansion()) continue;
                const char = text[index];
                if (char === "'" || char === '"') { quoted(char); continue; }
                if (char === "\\") { index += 2; continue; }
                if (char === "{") depth++;
                if (char === "}") depth--;
                index++;
            }
        }

        function expansion(): boolean {
            if (text.startsWith("$((", index)) { index++; arithmetic(); return true; }
            if (text.startsWith("$(", index)) { index += 2; shell(")"); return true; }
            if (text.startsWith("${", index)) { parameter(); return true; }
            if (text[index] === "`") { index++; shell("`"); return true; }
            return false;
        }

        function hereDoc(): HereDoc | undefined {
            index += 2;
            const stripTabs = text[index] === "-";
            if (stripTabs) index++;
            while (text[index] === " " || text[index] === "\t") index++;
            let delimiter = "", quote: "'" | '"' | undefined, wasQuoted = false, started = false;
            while (index < text.length) {
                const char = text[index]!;
                if (!quote && (text.startsWith("$'", index) || text.startsWith('$"', index))) {
                    throw new SyntaxError("Use a plain or simply quoted heredoc delimiter");
                }
                if (!quote && /[ \t\n;|&<>()]/.test(char)) break;
                started = true;
                if ((char === "'" || char === '"') && (!quote || quote === char)) {
                    wasQuoted = true; quote = quote ? undefined : char; index++; continue;
                }
                if (char === "\\" && quote !== "'") {
                    const next = text[index + 1];
                    if (next !== undefined && (!quote || /[$`"\\\n]/.test(next))) {
                        wasQuoted = true; index += 2;
                        if (next !== "\n") delimiter += next;
                        continue;
                    }
                }
                delimiter += char; index++;
            }
            return started ? {delimiter, quoted: wasQuoted, stripTabs} : undefined;
        }

        function bodies(documents: HereDoc[]): void {
            for (const doc of documents) {
                let body = "", terminated = false;
                while (index < text.length) {
                    let line = "";
                    for (;;) {
                        const end = text.indexOf("\n", index);
                        const part = text.slice(index, end < 0 ? text.length : end);
                        index = end < 0 ? text.length : end + 1;
                        line += part;
                        // Unquoted heredocs join escaped newlines before checking the delimiter.
                        const slashes = /\\+$/.exec(part)?.[0].length ?? 0;
                        if (!doc.quoted && end >= 0 && slashes % 2 === 1) { line = line.slice(0, -1); continue; }
                        break;
                    }
                    if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) { terminated = true; break; }
                    body += line + "\n";
                }
                if (!terminated) throw new SyntaxError("Heredoc terminator is missing or unsupported");
                if (!doc.quoted && scan(body, true)) background = true;
            }
        }

        function shell(stop?: ")" | "`"): void {
            const documents: HereDoc[] = [];
            let wordStart = true;
            while (index < text.length && !background) {
                const char = text[index]!;
                if (char === stop) { index++; return; }
                if (char === "\\") {
                    if (text[index + 1] !== "\n") wordStart = false;
                    index += 2; continue;
                }
                if (char === "#" && wordStart) {
                    while (index < text.length && text[index] !== "\n") index++;
                    continue;
                }
                if (char === "\n") { index++; bodies(documents.splice(0)); wordStart = true; continue; }
                if (text.startsWith("$'", index)) { index++; quoted("'", true); wordStart = false; continue; }
                if (char === "'" || char === '"') { quoted(char); wordStart = false; continue; }
                if (expansion()) { wordStart = false; continue; }
                if (text.startsWith("((", index)) { arithmetic(); wordStart = false; continue; }
                if (text.startsWith("<<<", index)) { index += 3; wordStart = true; continue; }
                if (text.startsWith("<<", index)) {
                    const doc = hereDoc(); if (doc) documents.push(doc);
                    wordStart = false; continue;
                }
                if (char === "(") { index++; shell(")"); wordStart = true; continue; }
                if (text.startsWith("&&", index) || text.startsWith("|&", index) || text.startsWith(";&", index) || text.startsWith("&>", index) || text.startsWith(">&", index) || text.startsWith("<&", index)) {
                    index += 2; wordStart = true; continue;
                }
                if (char === "&") { background = true; return; }
                wordStart = /[ \t;|<>()]/.test(char);
                index++;
            }
        }

        if (expansionsOnly) {
            while (index < text.length && !background) {
                if (text[index] === "\\" && /[$`\\\n]/.test(text[index + 1] ?? "")) index += 2;
                else if (!expansion()) index++;
            }
        } else shell();
        return background;
    }
    return scan(command);
}

function unsafeOption(tokens: readonly string[], short: string, long: readonly string[]): boolean {
    return tokens.slice(1).some(token => {
        if (token.startsWith("--")) {
            const name = token.split("=", 1)[0]!.slice(2);
            // GNU tools accept unique long-option abbreviations.
            return !!name && long.some(flag => flag.startsWith(name) || name === flag);
        }
        return token.startsWith("-") && [...short].some(flag => token.slice(1).includes(flag));
    });
}

function isShellArgvReadOnly(tokens: readonly string[]): boolean {
    const name = tokens[0];
    if (!name) return false;
    if (name === "git") {
        return READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1] ?? "") &&
            !unsafeOption(tokens, tokens[1] === "grep" ? "O" : "", [
                "output", "ext-diff", "textconv", "open-files-in-pager", "exec-path", "config-env",
            ]);
    }
    if (!READ_ONLY_COMMANDS.has(name)) return false;
    if ((name === "sort" || name === "tree") && unsafeOption(tokens, "o", ["output", "compress-program"])) return false;
    if (name === "rg" && unsafeOption(tokens, "", ["pre", "hostname-bin"])) return false;
    if (name === "file" && unsafeOption(tokens, "C", ["compile"])) return false;
    // date operands can set the clock; uniq's second operand is an output file.
    if (name === "date") return tokens.slice(1).every(token => token.startsWith("+") || ["-u", "--utc", "--universal", "-R", "--rfc-email", "-I", "--iso-8601"].includes(token));
    if (name === "uniq") {
        let optionsEnded = false;
        let operands = 0;
        for (const token of tokens.slice(1)) {
            if (!optionsEnded && token === "--") { optionsEnded = true; continue; }
            if (optionsEnded || token === "-" || !token.startsWith("-")) operands++;
        }
        return operands <= 1;
    }
    return true;
}

export function isShellCommandReadOnly(command: string): boolean {
    const parsed = parseShellCommand(command);
    return parsed.literal && parsed.segments.every(segment => isShellArgvReadOnly(segment.tokens));
}

export function generateShellAllowPattern(command: string): string | null {
    const parsed = parseShellCommand(command);
    if (!parsed.literal) return null;
    const prefixes = parsed.segments.map(({tokens}) => {
        const length = ["npm", "pnpm", "yarn", "bun"].includes(tokens[0]!) ? 3 : 2;
        const prefix = tokens.slice(0, length);
        // Rule patterns have their own wildcard grammar. Do not invent escaping for it.
        return prefix.every(token => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(token)) ? prefix.join(" ") : null;
    });
    return prefixes.every(prefix => prefix !== null) ? prefixes.map(prefix => `${prefix}:*`).join(" | ") : null;
}

export function isCompoundShellPattern(pattern: string): boolean {
    return splitShellSubCommands(pattern).length > 1;
}
