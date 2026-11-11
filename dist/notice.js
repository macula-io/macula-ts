/** A notice's internal shape in the notice it becomes. */
function noticeOf(item) {
    return item.kind === "gap"
        ? { kind: "gap", fromMs: item.from_ms, toMs: item.to_ms, reason: item.reason }
        : { kind: "interrupted", fromMs: item.from_ms, reason: item.reason };
}
/** Reads one item a subscription handed over, as the ABI wrote it. The JSON
 * is the library's own (CONTRACT.md "Inboxes"), cast once here: everything
 * past this point is the package's shape. */
export function itemOf(json) {
    const item = JSON.parse(json);
    if (item.kind === "interrupted" || item.kind === "gap")
        return { notice: noticeOf(item) };
    return { event: item };
}
//# sourceMappingURL=notice.js.map