import { basename, resolve } from "node:path";
import { LocalStore, canonicalDirectory, assertWorkspaceGit, findGitRoot, resolveLocalProject, sourceDefinitions, validateWorkspaceRepositories, type LocalWorkspace } from "@varveai/adit-core";
import { installSkillsWithReport, printSkillsSection } from "./skills.js";
import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
import { repositories, type CollectionJob, type Provider } from "../local/collector.js";
import { localRequest } from "./local-api.js";
import { canPromptForInit, selectInitChoices, confirmInit, InitCancelled } from "./init-selection.js";
import { repositoryChoices, sourceChoices, waitForInitJob } from "./init-discovery.js";

interface InitOptions { cwd?: string; yes?: boolean; platform?: string; force?: boolean; singleRepo?: boolean; multiRepo?: boolean; repos?: string[]; detach?: boolean; absorb?: boolean; }
export async function initCommand(opts: InitOptions = {}): Promise<void> {
  let store: LocalStore | undefined;
  try {
    if (opts.absorb) throw new Error("--absorb is no longer supported; projects keep their own identities.");
    if (opts.detach) throw new Error("--detach is no longer supported. Maintain project directories in Settings.");
    if ([!!opts.singleRepo, !!opts.multiRepo, !!opts.repos].filter(Boolean).length > 1)
      throw new Error("Choose only one of --single-repo, --multi-repo or --repos.");
    const cwd = canonicalDirectory(opts.cwd ?? process.cwd());
    let registered;
    try { registered = resolveLocalProject({path:cwd}); }
    catch (error) { if ((error as {status?:number}).status !== 404) throw error; }
    const root = registered?.projectRoot ?? findGitRoot(cwd) ?? cwd;
    assertWorkspaceGit(root);
    if (!opts.yes && !canPromptForInit())
      throw new Error("Run adit init in a terminal to choose repositories and sources, or use adit init --yes to accept detected selections and start organizing.");
    store = new LocalStore();
    const old = registered ? store.workspace(registered.projectId) : undefined;
    const definitions = sourceDefinitions();
    const aliases: Record<string,string> = {"claude-code":"claude","claude-vscode":"claude"};
    const provider = opts.platform ? aliases[opts.platform] ?? opts.platform : undefined;
    if (provider && !definitions.some(d => d.id === provider && d.supported)) throw new Error("Unsupported native history source: " + opts.platform);
    const dbPath = store.dbPath;
    store.close(); store = undefined;

    console.log(`ADIT Local · ${basename(root)}\n${root}\n\nChecking Git repositories…`);
    const discovered = await repositories(root);
    const requestedRepos = opts.repos ? opts.repos.map(p=>resolve(root,p)) : opts.singleRepo ? [root] : opts.multiRepo ? discovered.filter(r=>!r.error&&!r.skipReason).map(r=>r.path) : old?.repositories;
    if (requestedRepos) validateWorkspaceRepositories(root, requestedRepos);
    const gitChoices = repositoryChoices(root, discovered, requestedRepos);
    const selected = opts.yes ? gitChoices.filter(c=>c.checked).map(c=>c.id) : await selectInitChoices("1. Git repositories",gitChoices);
    for (const choice of gitChoices) console.log(`  [${selected.includes(choice.id)?"✓":" "}] ${choice.label} · ${choice.detail}`);

    console.log("\nChecking sessions for this directory. Full parsing and analysis start after confirmation.");
    const sources = await localRequest<Provider[]>("/providers");
    if (provider && !sources.find(p=>p.id===provider)?.enabled) throw new Error(`Enable ${provider} in Settings before selecting it.`);
    const discovery = await waitForInitJob(await localRequest<CollectionJob>("/discoveries","POST",{path:root}));
    const choices = sourceChoices(sources,discovery,old,provider);
    const providers = opts.yes ? choices.filter(c=>c.checked).map(c=>c.id) : await selectInitChoices("2. Session sources",choices);
    if (!selected.length && !providers.length) throw new Error("Select at least one Git repository or session source before organizing.");
    console.log(`\nSelected: ${selected.length} Git repositories · ${providers.length} session sources`);
    for (const id of providers) {
      const choice=choices.find(c=>c.id===id)!;
      console.log(`  [✓] ${choice.label} · ${choice.detail}`);
    }
    if (!opts.yes && !await confirmInit()) { console.log("Canceled. Project settings were not changed."); return; }

    // The same optimistic save and collection queue used by the local page.
    // Cloud/login/schedule settings are deliberately omitted from this update.
    const workspace = await localRequest<LocalWorkspace>(old?`/workspaces/${old.id}`:"/workspaces",old?"PATCH":"POST",
      {path:root,name:old?.name??basename(root),providers,repositories:selected,...(old?{version:old.version}:{})});
    const cleanup = cleanupLegacyHooks(root);
    console.log(`Project ${old ? "updated" : "registered"}: ${workspace.name} (${workspace.id})`);
    console.log(`Storage: ${dbPath}`);
    for (const error of cleanup.errors) console.error(error);
    const skills = installSkillsWithReport();
    printSkillsSection(skills, 21);
    const job=await localRequest<CollectionJob>(`/workspaces/${workspace.id}/collect`,"POST",{});
    console.log("\nOrganizing started. You can also view progress with adit server.");
    const result=await waitForInitJob(job);
    if(result.status!=="done")process.exitCode=1;
    console.log("Run adit server to view the local history. Cloud settings are managed there or with adit cloud commands.");
  } catch (error) {
    if(error instanceof InitCancelled){console.log("Canceled. Project settings were not changed.");process.exitCode=130;}
    else {console.error(error instanceof Error ? error.message : String(error));process.exitCode=1;}
  }
  finally { store?.close(); }
}
