/** Classify a dsh tool name into the canonical ACP ToolKind vocabulary. */
export function classifyTool(name) {
    if (name === "write" || name === "edit" || name === "str_replace_editor" || name === "apply_patch")
        return "edit";
    if (name === "bash" || name === "pwsh" || name === "run_code")
        return "execute";
    if (name === "read" || name === "read_text_file" || name === "read_image" || name === "describe_image")
        return "read";
    if (name === "glob" || name === "grep" || name === "ls" || name === "search")
        return "search";
    if (name === "web_search" || name === "web_fetch" || name === "http_get")
        return "fetch";
    if (name === "rm" || name === "delete")
        return "delete";
    if (name === "move" || name === "rename")
        return "move";
    if (name === "think")
        return "think";
    return "other";
}
//# sourceMappingURL=tool-kind.js.map