// Read public model settings through HiCode's resolver; never read or print Key values.
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [repo, cwd, home, sourceOverride, modelOverride] = process.argv.slice(2);
try {
  const {loadHiCodeSettings} = await import(pathToFileURL(join(resolve(repo), 'src/settings/index.ts')).href);
  const {createHiCodeStorageLayout} = await import(pathToFileURL(join(resolve(repo), 'src/persistence/index.ts')).href);
  const {PROVIDER_BASE_URLS} = await import(pathToFileURL(join(resolve(repo), 'src/llm/providerRegistry.ts')).href);
  const loaded = loadHiCodeSettings({
    cwd: resolve(cwd), storage: createHiCodeStorageLayout({hicodeHome: resolve(home)}),
    sources: ['user', 'project', 'local'],
    cliOverrides: {source: sourceOverride, model: modelOverride},
  });
  if (loaded.issues.some(issue => issue.severity === 'error')) throw new Error('Invalid settings');
  const settings = loaded.values;
  const selected = settings.models.primary;
  const source = settings.sources[selected.source];
  const definition = source.models.find(model => model.id === selected.model);
  if (!definition) throw new Error('Model not found');
  process.stdout.write(JSON.stringify({
    source: selected.source, model: selected.model, apiKeyEnv: source.apiKeyEnv,
    baseUrl: source.baseUrl ?? PROVIDER_BASE_URLS[selected.source],
    imageInput: definition.imageInput === true,
  }));
} catch {
  process.stderr.write('Cannot resolve HiCode model settings. Configure /providers and /model from this checkout, or supply --model-config FILE (connection settings only, no API key).\n');
  process.exitCode = 1;
}
