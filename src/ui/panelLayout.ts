import stringWidth from "string-width";
import {useTerminalSize} from "./terminalSize.js";
import {wrapDisplayText} from "./fileChanges/layout.js";

/** All panels share terminal dimensions; only their content determines line breaks. */
export function usePanelLayout() {
    const {width, height} = useTerminalSize();
    const padding = Math.min(2, Math.floor((width - 1) / 2));
    return {width, height, padding, contentWidth: Math.max(1, width - padding * 2)};
}

/** Wrap from the original text on every width change, preserving explicit newlines. */
export function wrapPanelText(text: string, width: number): string[] {
    const columns = Math.max(1, width);
    return text.replace(/\t/g, "    ").split("\n").flatMap(line => {
        const rows: string[] = [];
        let current = "";
        for (const word of line.split(/(\s+)/)) {
            if (!word.trim()) {
                if (stringWidth(current + word) <= columns) current += word;
                continue;
            }
            if (current.trim() && stringWidth(current + word) > columns) {
                rows.push(current.trimEnd()); current = "";
            }
            const pieces = wrapDisplayText(current + word, columns);
            rows.push(...pieces.slice(0, -1));
            current = pieces.at(-1) ?? "";
        }
        rows.push(current.trimEnd());
        return rows;
    });
}

/** Keep the selected item visible and fill remaining space by actual wrapped rows. */
export function panelWindow(heights: readonly number[], selected: number, availableRows: number) {
    if (!heights.length) return {start: 0, end: 0};
    const budget = Math.max(1, availableRows);
    let start = Math.max(0, Math.min(selected, heights.length - 1));
    let end = start + 1;
    let used = heights[start]!;
    while (start > 0 && used + heights[start - 1]! <= budget) used += heights[--start]!;
    while (end < heights.length && used + heights[end]! <= budget) used += heights[end++]!;
    return {start, end};
}
