import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./session.js";
import { getConfigSchema } from "./config-schema.js";
export function createServerAdapter() {
    return {
        type,
        execute,
        testEnvironment,
        sessionCodec,
        models,
        supportsLocalAgentJwt: true,
        agentConfigurationDoc,
        getConfigSchema,
    };
}
export { execute, testEnvironment, sessionCodec };
//# sourceMappingURL=index.js.map