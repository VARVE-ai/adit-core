import { installSkillsCommand } from "./commands/skills.js";

const result = installSkillsCommand();
if (result.errors.length) console.warn("CLI installed, but skill installation was incomplete. Run 'adit init' to retry after fixing the reported paths.");
