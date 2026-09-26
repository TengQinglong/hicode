import {createTestSettings} from "../helpers/runtimeResources.js";
import {createHiCodeRootConfiguration} from "../../src/runtime/rootConfiguration.js";
import {createHiCodeStorageLayout} from "../../src/persistence/layout.js";
import {runHeadlessFromCli} from "../../src/headless/cli.js";

const [cwd, hicodeHome, baseUrl] = process.argv.slice(2);
if (!cwd || !hicodeHome || !baseUrl) throw new Error("Missing fixture arguments");
const settings = createTestSettings();
settings.sources = {...settings.sources, glm: {...settings.sources.glm, baseUrl, apiKeyEnv: "HICODE_FIXTURE_API_KEY"}};
settings.sandbox = {filesystem: {denyRead: [], denyWrite: []}, network: {mode: "open", allowedDomains: [], allowLocalBinding: false}};
const configuration = createHiCodeRootConfiguration({cwd, workspaceBoundary: cwd,
    storage: createHiCodeStorageLayout({hicodeHome}), settings,
    fileSources: {settings: [], instructions: [], skills: [], agents: [], mcp: []},
});
await runHeadlessFromCli({configuration, prompt: "fixture only", resumeMode: {kind: "none"}, outputFormat: "json"});
