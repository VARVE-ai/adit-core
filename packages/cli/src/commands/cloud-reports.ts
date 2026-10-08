/**
 * Read-only reporting commands: `adit cloud usage|reports|team`.
 */

import { Command, Option } from "commander";
import { cloudDailyReports, cloudTeamProgress, cloudUsage, listCloudTeamMembers } from "@varveai/adit-cloud";
import { calendarDay, periodOptions, printJson, reportFailure, requireCloudClient } from "./cloud-read-output.js";
import {
  arrow,
  dim,
  formatCount,
  joinParts,
  localDateTime,
  localMoment,
  localTime,
  marks,
  padEnd,
  plural,
  printEnd,
  printLine,
  printSection,
  printTable,
  printTitle,
  shortId,
  stateWord,
  strong,
  summaryColumns,
  truncate,
} from "./cli-style.js";

type Json = { json?: boolean };
type PeriodOptions = { from?: string; to?: string; tz?: string };

function personName(person: { name: string | null; email: string | null; id: string }): string {
  return person.name ?? person.email ?? person.id;
}

function periodLabel(period: { from: string | null; to: string | null }): string {
  if (period.from && period.from === period.to) return period.from;
  return `${period.from ?? "any"} ${arrow()} ${period.to ?? "any"}`;
}

export async function cloudUsageCommand(options: Json & PeriodOptions & { by?: string; scope?: string; team?: string; member?: string; project?: string }): Promise<void> {
  try {
    const result = await cloudUsage(requireCloudClient(), { ...periodOptions(options), by: options.by, scope: options.scope, team: options.team, member: options.member, project: options.project });
    if (options.json) return printJson(result);
    const who = result.scope.member
      ? personName(result.scope.member)
      : result.scope.team
        ? `team ${result.scope.team.name}`
        : result.scope.kind === "me" ? "yours" : result.scope.kind;
    const scope = [who, periodLabel(result.period), result.period.timeZone, `by ${result.by}`];
    if (result.rows.length === 0 && result.totals.requests === 0) {
      printTitle("Usage", ...scope);
      printEnd(`${marks.skip} No usage recorded in this period`);
      return;
    }
    printTitle("Usage", ...scope);
    const cost = (value: string | null) => value !== null ? `$${value}` : dim("unpriced");
    const cells = (label: string, row: typeof result.totals | (typeof result.rows)[number]) => [
      label,
      formatCount(row.requests),
      formatCount(row.inputTokens),
      formatCount(row.outputTokens),
      formatCount(row.cacheReadTokens),
      cost(row.estimatedCostUsd),
      row.unpricedRequests ? dim(`${row.unpricedRequests} unpriced`) : "",
    ];
    printTable(
      [
        { header: result.by },
        { header: "requests", align: "right" },
        { header: "input", align: "right" },
        { header: "output", align: "right" },
        { header: "cache read", align: "right" },
        { header: "cost", align: "right" },
        { header: "" },
      ],
      [
        ...result.rows.map((row) => cells(truncate(row.label, 30), row)),
        cells("total", result.totals).map((cell) => (cell ? strong(cell) : cell)),
      ],
    );
    const other = result.by === "day" ? "model" : "day";
    printEnd(dim(joinParts([
      "estimates from list prices",
      result.unreadableSessions > 0 ? `${plural(result.unreadableSessions, "session")} unreadable` : null,
      `by ${other}: ${strong(`adit cloud usage --by ${other}`)}`,
    ])));
  } catch (error) { reportFailure(error, options, "usage"); }
}

export async function cloudReportsDailyCommand(options: Json & PeriodOptions & { date?: string; team?: string; member?: string }): Promise<void> {
  try {
    const result = await cloudDailyReports(requireCloudClient(), { date: calendarDay(options.date, "--date"), ...periodOptions(options), team: options.team, member: options.member });
    if (options.json) return printJson(result);
    const members = new Set(result.reports.map((report) => report.member.id));
    const dates = new Set(result.reports.map((report) => report.workDate));
    const firstMember = result.reports[0]?.member;
    const scope = [
      periodLabel(result.period),
      members.size === 1 && firstMember ? personName(firstMember) : null,
      result.reports.length > 0 ? plural(new Set(result.reports.map((report) => report.team.id)).size, "team") : null,
    ];
    if (!result.reports.length) {
      printTitle("Daily reports", ...scope);
      printEnd(`${marks.skip} You are not in any team, so there are no daily reports`);
      return;
    }
    printTitle("Daily reports", ...scope);
    const width = summaryColumns(30);
    for (const report of result.reports) {
      printSection(
        report.team.name,
        members.size > 1 ? personName(report.member) : null,
        dates.size > 1 ? report.workDate : null,
        stateWord(report.state),
        report.generatedAt ? localMoment(report.generatedAt, new Date().toISOString()) : null,
      );
      if (report.state === "failed") {
        printLine(`${marks.fail} the report failed${report.error ? `: ${truncate(report.error, width)}` : ""}`);
        continue;
      }
      if (report.cards.length === 0) {
        printLine(dim(report.state === "pending" || report.state === "generating" ? "The report is being generated." : "No report for this day."));
        continue;
      }
      for (const card of report.cards) {
        printLine(`${padEnd(stateWord(card.stage), 12)}${strong(truncate(card.title, 60))}${card.stageReason ? dim(` · ${truncate(card.stageReason, 40)}`) : ""}`);
        if (card.contribution) printLine(`${" ".repeat(12)}${truncate(card.contribution, width)}`);
        for (const evidence of card.evidence) {
          printLine(`${" ".repeat(12)}${dim(`${padEnd(evidence.kind, 9)} ${localTime(evidence.at)}`)}  ${truncate(evidence.title, width - 16)}`);
        }
      }
    }
    printEnd();
  } catch (error) { reportFailure(error, options, "reports daily"); }
}

export async function cloudTeamMembersCommand(options: Json & { team?: string }): Promise<void> {
  try {
    if (!options.team) throw new Error("--team is required; find the ID with 'adit cloud teams list'");
    const result = await listCloudTeamMembers(requireCloudClient(), options.team);
    if (options.json) return printJson(result);
    printTitle(
      `Team ${result.team.name}`,
      plural(result.members.length, "member"),
      `you are ${result.viewer.role}${result.viewer.canQueryOthers ? ", can query others" : ", can query only yourself"}`,
    );
    printTable(
      [{ header: "id" }, { header: "role" }, { header: "name" }, { header: "email" }],
      result.members.map((member) => [member.id, member.role, strong(truncate(member.name ?? "(no name)", 24)), member.email ?? "-"]),
    );
    printEnd(result.viewer.canQueryOthers
      ? dim(`progress: ${strong(`adit cloud team progress --team ${result.team.id} --member <id>`)}`)
      : undefined);
  } catch (error) { reportFailure(error, options, "team members", `find the team ID with ${strong("adit cloud teams list")}`); }
}

export async function cloudTeamProgressCommand(options: Json & PeriodOptions & { team?: string; member?: string; query?: string }): Promise<void> {
  try {
    if (!options.team) throw new Error("--team is required; find the ID with 'adit cloud teams list'");
    if (!options.member) throw new Error("--member is required; find the ID with 'adit cloud team members'");
    const result = await cloudTeamProgress(requireCloudClient(), options.team, { member: options.member, q: options.query, ...periodOptions(options) });
    if (options.json) return printJson(result);
    const scope = [`${personName(result.member)} in ${result.team.name}`, result.query ? `"${result.query}"` : null, periodLabel(result.period)];
    if (!result.tasks.length && !result.sessions.length && !result.cards.length && !result.commits.length) {
      printTitle("Progress", ...scope);
      printEnd(`${marks.skip} Nothing recorded for this member matches`);
      return;
    }
    printTitle("Progress", ...scope);
    const width = summaryColumns(40);
    if (result.tasks.length) {
      printSection("Tasks");
      printTable(
        [{ header: "" }, { header: "" }, { header: "" }, { header: "" }],
        result.tasks.map((task) => [task.id, stateWord(task.progressState), task.dueAt ? task.dueAt.slice(0, 10) : "-", truncate(task.title, 60)]),
      );
    }
    if (result.sessions.length) {
      printSection("Sessions");
      printTable(
        [{ header: "" }, { header: "" }, { header: "" }],
        result.sessions.map((session) => [
          session.id,
          localDateTime(session.startedAt),
          truncate(session.sections.map((section) => `#${section.sequence} ${section.title}`).join(" · "), width),
        ]),
      );
    }
    if (result.cards.length) {
      printSection("Work cards");
      for (const card of result.cards) {
        printLine(`${padEnd(stateWord(card.stage), 12)}${strong(truncate(card.title, 60))}`);
        if (card.contribution) printLine(`${" ".repeat(12)}${truncate(card.contribution, width)}`);
        for (const evidence of card.evidence) {
          printLine(`${" ".repeat(12)}${dim(`${padEnd(evidence.kind, 9)} ${localDateTime(evidence.at)}`)}  ${truncate(evidence.title, width - 26)}`);
        }
      }
    }
    if (result.commits.length) {
      printSection("Commits");
      printTable(
        [{ header: "" }, { header: "" }, { header: "" }],
        result.commits.map((commit) => [shortId(commit.sha), localDateTime(commit.committedAt), truncate(commit.message, width)]),
      );
    }
    printEnd();
  } catch (error) { reportFailure(error, options, "team progress", `check the IDs with ${strong("adit cloud teams list")} and ${strong("adit cloud team members --team <id>")}`); }
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
