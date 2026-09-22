import { installTaskSkillCommand } from "./commands/task-skill.js";

const result = installTaskSkillCommand();
if (result.errors.length) console.warn("CLI installed, but task skill installation was incomplete. Run 'adit init' to retry after fixing the reported paths.");
