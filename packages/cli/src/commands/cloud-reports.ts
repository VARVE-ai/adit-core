/**
 * Read-only reporting commands: `adit cloud usage|reports|team`.
 */

import { Command, Option } from "commander";
import { cloudDailyReports, cloudTeamProgress, cloudUsage, listCloudTeamMembers, type CloudUsageTotals } from "@varveai/adit-cloud";
import { calendarDay, oneLine, periodOptions, printJson, reportFailure, requireCloudClient, shortTime } from "./cloud-read-output.js";

type Json = { json?: boolean };
type PeriodOptions = { from?: string; to?: string; tz?: string };

function usageLine(label: string, row: CloudUsageTotals): string {
  return `${label.padEnd(28)}  ${String(row.requests).padStart(6)} req  in ${String(row.inputTokens).padStart(10)}  out ${String(row.outputTokens).padStart(9)}  cache read ${String(row.cacheReadTokens).padStart(10)}  ${row.estimatedCostUsd !== null ? `$${row.estimatedCostUsd}` : "unpriced"}${row.unpricedRequests ? ` (${row.unpricedRequests} unpriced)` : ""}`;
}

export async function cloudUsageCommand(options: Json & PeriodOptions & { by?: string; scope?: string; team?: string; member?: string; project?: string }): Promise<void> {
  try {
    const result = await cloudUsage(requireCloudClient(), { ...periodOptions(options), by: options.by, scope: options.scope, team: options.team, member: options.member, project: options.project });
    if (options.json) return printJson(result);
    console.log(`Usage ${result.period.from} to ${result.period.to} (${result.period.timeZone}), scope ${result.scope.kind}${result.scope.team ? ` team ${result.scope.team.name}` : ""}${result.scope.member ? ` member ${result.scope.member.name ?? result.scope.member.email ?? result.scope.member.id}` : ""}, by ${result.by}`);
    console.log(usageLine("total", result.totals));
    for (const row of result.rows) console.log(usageLine(oneLine(row.label, 28), row));
    console.log(result.note);
  } catch (error) { reportFailure(error, options, "Usage"); }
}

export async function cloudReportsDailyCommand(options: Json & PeriodOptions & { date?: string; team?: string; member?: string }): Promise<void> {
  try {
    const result = await cloudDailyReports(requireCloudClient(), { date: calendarDay(options.date, "--date"), ...periodOptions(options), team: options.team, member: options.member });
    if (options.json) return printJson(result);
    if (!result.reports.length) return console.log("No teams, so no daily reports.");
    for (const report of result.reports) {
      console.log(`${report.workDate}  ${oneLine(report.team.name, 30)}  ${report.member.name ?? report.member.email ?? report.member.id}  ${report.state}${report.error ? `: ${oneLine(report.error, 80)}` : ""}`);
      for (const card of report.cards) {
        console.log(`  [${card.stage}] ${oneLine(card.title, 60)}: ${oneLine(card.contribution, 120)}`);
        for (const evidence of card.evidence) console.log(`      ${evidence.kind} ${shortTime(evidence.at)}  ${oneLine(evidence.title, 80)}`);
      }
    }
  } catch (error) { reportFailure(error, options, "Daily report"); }
}

export async function cloudTeamMembersCommand(options: Json & { team?: string }): Promise<void> {
  try {
    if (!options.team) throw new Error("--team is required; find the ID with 'adit cloud teams list'");
    const result = await listCloudTeamMembers(requireCloudClient(), options.team);
    if (options.json) return printJson(result);
    console.log(`${result.team.name}: you are ${result.viewer.role}${result.viewer.canQueryOthers ? " and can query other members" : " and can query only yourself"}`);
    for (const member of result.members) console.log(`${member.id}  ${member.role.padEnd(6)}  ${oneLine(member.name ?? "(no name)", 30)}  ${member.email ?? ""}`);
  } catch (error) { reportFailure(error, options, "Team members"); }
}

export async function cloudTeamProgressCommand(options: Json & PeriodOptions & { team?: string; member?: string; query?: string }): Promise<void> {
  try {
    if (!options.team) throw new Error("--team is required; find the ID with 'adit cloud teams list'");
    if (!options.member) throw new Error("--member is required; find the ID with 'adit cloud team members'");
    const result = await cloudTeamProgress(requireCloudClient(), options.team, { member: options.member, q: options.query, ...periodOptions(options) });
    if (options.json) return printJson(result);
    console.log(`${result.member.name ?? result.member.email ?? result.member.id} in ${result.team.name}${result.query ? ` on "${result.query}"` : ""}, ${result.period.from ?? "any"} to ${result.period.to ?? "any"}`);
    for (const task of result.tasks) console.log(`task ${task.id}  ${task.progressState}  ${oneLine(task.title, 60)}${task.dueAt ? `  due ${task.dueAt.slice(0, 10)}` : ""}`);
    for (const session of result.sessions) console.log(`session ${session.id}  ${shortTime(session.startedAt)}  ${session.sections.map((section) => `#${section.sequence} ${section.title}`).join("; ")}`);
    for (const evidence of result.evidence) console.log(`evidence ${shortTime(evidence.at)}  [${evidence.card.stage}] ${oneLine(evidence.card.title, 40)}: ${oneLine(evidence.summary ?? evidence.title, 80)}`);
    for (const commit of result.commits) console.log(`commit ${commit.sha.slice(0, 10)}  ${shortTime(commit.committedAt)}  ${oneLine(commit.message, 70)}`);
    if (!result.tasks.length && !result.sessions.length && !result.evidence.length && !result.commits.length) console.log("Nothing recorded for this member matches.");
  } catch (error) { reportFailure(error, options, "Team progress"); }
}

function withPeriod(command: Command): Command {
  return command
    .option("--from <date>", "First calendar day, YYYY-MM-DD")
    .option("--to <date>", "Last calendar day, YYYY-MM-DD")
    .option("--tz <zone>", "IANA time zone; defaults to this machine's zone");
}

export function registerCloudReportCommands(cloud: Command): void {
  withPeriod(cloud.command("usage").description("Token usage and estimated cost (defaults to the last 7 days)"))
    .addOption(new Option("--by <dimension>", "Group rows by").choices(["model", "day", "session", "member"]).default("model"))
    .addOption(new Option("--scope <scope>", "Your own usage or a team's").choices(["me", "team"]).default("me"))
    .option("--team <id>", "Team ID for scope team").option("--member <id>", "One member of the team").option("--project <id>", "Limit to one project")
    .option("--json", "Output JSON").action((options) => cloudUsageCommand(options));

  const reports = cloud.command("reports").description("Daily work reports");
  withPeriod(reports.command("daily").description("Read daily reports (defaults to today)"))
    .option("--date <date>", "One calendar day, YYYY-MM-DD")
    .option("--team <id>", "Team ID; defaults to every team you belong to").option("--member <id>", "Another member (owners and leads only)")
    .option("--json", "Output JSON").action((options) => cloudReportsDailyCommand(options));

  const team = cloud.command("team").description("Team members and their progress");
  team.command("members").description("List a team's members with roles").requiredOption("--team <id>", "Team ID").option("--json", "Output JSON").action((options) => cloudTeamMembersCommand(options));
  withPeriod(team.command("progress").description("A member's tasks, sessions, evidence and commits for a feature"))
    .requiredOption("--team <id>", "Team ID").requiredOption("--member <id>", "Member ID").option("--query <text>", "Feature words to match")
    .option("--json", "Output JSON").action((options) => cloudTeamProgressCommand(options));
}
