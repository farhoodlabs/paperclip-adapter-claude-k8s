import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./session.js";
import { getConfigSchema } from "./config-schema.js";
import { listK8sSkills, syncK8sSkills } from "./skills.js";
import { listK8sModels } from "./models.js";
const sessionManagement = {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
    },
};
export function createServerAdapter() {
    return {
        type,
        execute,
        testEnvironment,
        sessionCodec,
        sessionManagement,
        models,
        listModels: listK8sModels,
        listSkills: listK8sSkills,
        syncSkills: syncK8sSkills,
        supportsLocalAgentJwt: true,
        supportsInstructionsBundle: true,
        instructionsPathKey: "instructionsFilePath",
        requiresMaterializedRuntimeSkills: false,
        agentConfigurationDoc,
        getConfigSchema,
    };
}
export { execute, testEnvironment, sessionCodec };
//# sourceMappingURL=index.js.map