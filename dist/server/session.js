function readNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function extractSessionFields(record) {
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    const cwd = readNonEmptyString(record.cwd) ??
        readNonEmptyString(record.workdir) ??
        readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const promptBundleKey = readNonEmptyString(record.promptBundleKey) ?? readNonEmptyString(record.prompt_bundle_key);
    return { sessionId, cwd, workspaceId, repoUrl, repoRef, promptBundleKey };
}
export const sessionCodec = {
    deserialize(raw) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            return null;
        const { sessionId, cwd, workspaceId, repoUrl, repoRef, promptBundleKey } = extractSessionFields(raw);
        if (!sessionId)
            return null;
        return {
            sessionId,
            ...(cwd ? { cwd } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(repoUrl ? { repoUrl } : {}),
            ...(repoRef ? { repoRef } : {}),
            ...(promptBundleKey ? { promptBundleKey } : {}),
        };
    },
    serialize(params) {
        if (!params)
            return null;
        const { sessionId, cwd, workspaceId, repoUrl, repoRef, promptBundleKey } = extractSessionFields(params);
        if (!sessionId)
            return null;
        return {
            sessionId,
            ...(cwd ? { cwd } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(repoUrl ? { repoUrl } : {}),
            ...(repoRef ? { repoRef } : {}),
            ...(promptBundleKey ? { promptBundleKey } : {}),
        };
    },
    getDisplayId(params) {
        if (!params)
            return null;
        return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    },
};
//# sourceMappingURL=session.js.map