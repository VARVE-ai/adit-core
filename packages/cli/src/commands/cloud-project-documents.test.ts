import { expect, it, vi } from "vitest";
const context = vi.hoisted(() => vi.fn(() => ({ projectId: "current-workspace" })));
vi.mock("./project-context.js", () => ({ loadProjectContext: context }));
import { documentDestination } from "./cloud-project-documents.js";

it("does not infer a destination or require a workspace for team documents", () => {
  context.mockClear();
  expect(() => documentDestination({})).toThrow("Choose the destination first");
  const team = "00000000-0000-4000-8000-000000000001";
  expect(documentDestination({ team })).toEqual({ teamId: team, scope: "team" });
  expect(context).not.toHaveBeenCalled();
  expect(() => documentDestination({ team, project: "workspace" })).toThrow();
  expect(() => documentDestination({ team, personal: true })).toThrow();
  expect(documentDestination({ project: "selected-workspace" })).toEqual({ localProjectId: "selected-workspace", scope: "personal" });
  expect(context).not.toHaveBeenCalled();
  expect(documentDestination({ personal: true })).toEqual({ localProjectId: "current-workspace", scope: "personal" });
});
